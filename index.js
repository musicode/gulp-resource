/**
 * @file 处理前端资源
 * @author musicode
 */

var fs = require('fs');
var path = require('path');
var crypto = require('crypto');

var es = require('event-stream');

var amdDeploy = require('amd-deploy');
var parseFile = require('amd-deploy/lib/parseFile');
var resolveResourceId = require('amd-deploy/lib/resolveResourceId');
var resourceIdToFilePath = require('amd-deploy/lib/resourceIdToFilePath');
var generateFileCode = require('amd-deploy/lib/generateFileCode');
var parseFactoryResources = require('amd-deploy/lib/parseFactoryResources');
var replaceResources = require('amd-deploy/lib/replaceResources');
var util = require('amd-deploy/lib/util');

var htmlRules = [

    {
        pattern: /href=['"](?:[^'"]+\.(?:css|less|styl)(?:\?.+)?)['"]/gi,
        match: function (result) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {
                return terms[1];
            }
        }
    },

    {
        pattern: /src=['"](?:[^'"]+\.(?:js|jpg|jpeg|png|gif|ico|cur)(?:\?.+)?)['"]/gi,
        match: function (result) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {
                return terms[1];
            }
        }
    }

];

var cssRules = [

    {
        pattern: /@import\s+['"](?:[^'")]+)['"]/gi,
        match: function (result) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {
                return terms[1];
            }
        }
    },

    {
        pattern: /url\(['"]?(?:[^'")]+)['"]?\)/gi,
        match: function (result) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {
                return terms[1];
            }
            else {
                return result.split('(')[1].split(')')[0];
            }
        }
    }

];

function md5(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex').slice(0, 10);
}


function each(obj, fn) {
    for (var key in obj) {
        if (obj.hasOwnProperty(key)) {
            fn(key, obj[key]);
        }
    }
}

function merge(source, target) {
    each(target, function (key, value) {
        source.push(value);
    });
}

function extend(source, target) {
    each(target, function (key, value) {
        source[key] = value;
    });
    return source;
}

/**
 * 是否是绝对路径
 *
 * @inner
 * @param {string}  url
 * @return {boolean}
 */
function isAbsolute(url) {
    return /^(?:https?|data|javascript):/i.test(url);
}

/**
 * 正则替换
 *
 * @inner
 * @param {string} content
 * @param {string} pattern
 * @param {string|Function} replacement
 * @return {string}
 */
function replaceByPattern(content, pattern, replacement) {
    pattern = pattern.replace(/(\{|\}|\(|\)|\$|\.|\/)/g, '\\$1');
    return content.replace(
        new RegExp(pattern, 'g'),
        replacement
    );
}

/**
 * 正则全局提取依赖
 *
 * @inner
 * @param {Object} file
 * @param {Array} rules
 * @return {Array}
 */
function walkDependencies(file, rules) {

    var directory = path.dirname(file.path);
    var content = file.contents.toString();

    var list = [ ];
    var map = { };

    var addDependency = function (dependency) {
        if (!map[dependency.raw]) {
            map[dependency.raw] = 1;
            list.push(dependency);
        }
    };

    rules.forEach(function (parser, index) {

        var results = content.match(parser.pattern);

        if (results) {
            results.forEach(function (result) {

                var dependencies = parser.match(result);
                if (!dependencies) {
                    return;
                }

                if (!Array.isArray(dependencies)) {
                    dependencies = [ dependencies ];
                }

                dependencies.forEach(function (dependency) {

                    // 支持返回对象，必须包含 raw 属性
                    if (typeof dependency === 'string') {
                        dependency = {
                            raw: dependency
                        };
                    }

                    var raw = dependency.raw;

                    // 防止有 ?v=xxx 这种形式
                    var query = path.extname(raw).split('?')[1];
                    if (query && query.length > 0) {

                        raw =
                        dependency.raw =

                        raw.substr(
                            0,
                            raw.length - (query.length + 1)
                        );

                    }

                    if (!dependency.absolute) {
                        dependency.absolute = /^(?:\w|\.(?:\.)?)/.test(raw)
                                            ? path.join(directory, raw)
                                            : raw;

                    }

                    // 便于替换
                    dependency.text = result;

                    addDependency(dependency);

                });

            });

        }

    });

    return list;

}

/**
 * 纠正依赖的格式
 *
 * 开发时通常会约定一些不通用的路径，如 ${staticServer}/src/a.js，编译时需要处理
 *
 * @inner
 * @param {Array} dependencies
 * @param {Function} correct
 */
function correctDependencies(dependencies, correct) {

    if (!correct) {
        return;
    }

    for (var i = dependencies.length - 1; i >= 0; i--) {
        correct(dependencies[i]);
    }

}

/**
 * 过滤一些不需要的依赖，通常在 correctDependencies 之后处理
 *
 * @inner
 * @param {Array} dependencies
 * @param {Function} filter 返回 true 表示需要过滤
 */
function filterDependencies(dependencies, filter) {

    for (var i = dependencies.length - 1; i >= 0; i--) {

        var dependency = dependencies[i];

        // 绝对路径不用处理
        if (isAbsolute(dependency.raw)
            || (filter && filter(dependency))
        ) {
            dependencies.splice(i, 1);
        }

    }

}

/**
 * 替换依赖
 *
 * @inner
 * @param {Object} file
 * @param {Array} dependencies
 * @param {Function} replace
 */
function replaceDependencies(file, dependencies, replace) {

    var srcContent = file.contents.toString();
    var destContent = srcContent;

    dependencies.forEach(function (dependency) {
        destContent = replaceByPattern(
            destContent,
            dependency.text,
            function (result) {

                var replacement = replace(dependency);

                if (replacement) {
                    return replaceByPattern(
                        result,
                        dependency.raw,
                        replacement
                    );
                }

                return result;

            }
        );
    });

    if (srcContent !== destContent) {
        file.contents = new Buffer(destContent);
    }

}


/**
 *
 * @param {Object} options
 * @property {Array} options.htmlRules
 * @property {Array} options.cssRules
 * @property {Object} options.amdConfig
 * @property {Function} options.renameFile 重命名文件，比如加上 md5
 * @property {Function=} options.filterDependency 过滤非法依赖，比如 src/img/${a}.jpg
 * @property {Function=} options.renameDependency 重命名依赖，按 md5 进行替换时可以自定义替换规则
 * @property {Function} options.correctDependency 纠正依赖的格式，比如开发约定 {{ $static_server }}/src 开头
 *                                                build 需要纠正为正确的路径
 */
function Resource(options) {

    extend(this, options);

    this.htmlRules = options.htmlRules || [ ];
    this.cssRules = options.cssRules || [ ];

    merge(this.htmlRules, htmlRules);
    merge(this.cssRules, cssRules);

    this.hashMap = { };
    this.dependencyMap = { };

}

Resource.prototype = {

    constructor: Resource,

    /**
     * 自定义处理
     *
     * @param {Function} handler
     */
    custom: function (handler) {
        return es.map(function (file, callback) {
            handler(
                file,
                function () {
                    callback(null, file);
                }
            );
        });
    },

    /**
     * 获取 html 文件的依赖
     *
     * @param {Object} options
     * @property {Function} options.process
     * @property {Function} options.replace
     */
    htmlDependencies: function (options) {

        var me = this;

        return es.map(function (file, callback) {

            var dependencies = walkDependencies(
                file,
                me.htmlRules
            );

            correctDependencies(
                dependencies,
                me.correctDependency
            );

            filterDependencies(
                dependencies,
                me.filterDependency
            );

            if (options.process) {
                options.process(file, dependencies);
            }

            if (options.replace) {

                replaceDependencies(
                    file,
                    dependencies,
                    function (dependency) {
                        return options.replace(
                            dependency,
                            me.hashMap,
                            me.dependencyMap
                        );
                    }
                );

            }

            callback(null, file);

        });
    },

    /**
     * 获取 css 文件的依赖
     *
     * @param {Object} options
     * @property {Function} options.process
     * @property {Function} options.replace
     */
    cssDependencies: function (options) {

        var me = this;

        return es.map(function (file, callback) {

            var dependencies = walkDependencies(
                file,
                me.cssRules
            );

            correctDependencies(
                dependencies,
                me.correctDependency
            );

            filterDependencies(
                dependencies,
                me.filterDependency
            );

            if (options.process) {
                options.process(file, dependencies);
            }

            if (options.replace) {

                replaceDependencies(
                    file,
                    dependencies,
                    function (dependency) {
                        return options.replace(
                            dependency,
                            me.hashMap,
                            me.dependencyMap
                        );
                    }
                );

            }

            callback(null, file);

        });
    },

    /**
     * 获取 amd 文件的依赖
     *
     * @param {Object} options
     * @property {Function} options.process
     * @property {Function} options.replace
     */
    amdDependencies: function (options) {

        var me = this;

        var replace = options.replace;

        var config = { };
        extend(config, me.amdConfig);

        if (replace) {
            config.replaceRequireResource = function (raw, absolute) {
                return replace({
                    raw: raw,
                    absolute: absolute
                });
            };
        }

        return es.map(function (file, callback) {

            var dependencies = [ ];

            var fileInfo = parseFile(
                file.path,
                file.contents.toString(),
                config
            );

            fileInfo.modules.forEach(
                function (module) {

                    var resources = parseFactoryResources(module.factory);

                    [
                        // 同步
                        module.dependencies,
                        // 异步
                        resources.async
                    ]
                    .forEach(function (resources) {

                        resources.forEach(function (resource) {

                            if (util.keywords[resource.id]) {
                                return;
                            }

                            var resourceId = resolveResourceId(resource.id, module.id);

                            dependencies.push({
                                raw: resource.id,
                                absolute: resourceIdToFilePath(resourceId, config)
                            });

                        });

                    });
                }
            );

            correctDependencies(
                dependencies,
                me.correctDependency
            );

            filterDependencies(
                dependencies,
                me.filterDependency
            );

            if (options.process) {
                options.process(file, dependencies);
            }

            if (replace) {

                replaceResources(
                    fileInfo,
                    config
                );

                file.contents = new Buffer(
                    generateFileCode(fileInfo)
                );

            }

            callback(null, file);

        });
    },


    /**
     * 分析文件的 hash
     */
    analyzeFileHash: function () {

        var me = this;

        return es.map(function (file, callback) {

            if (file.isBuffer()) {

                var filePath = file.path;
                var hash = me.hashMap[ filePath ];

                if (!hash) {
                    hash = md5(file.contents);
                    me.hashMap[ filePath ] = hash;
                }

            }

            callback(null, file);

        });

    },

    /**
     * 分析文件的依赖
     *
     * 只能分析 html css amd 三种文件
     *
     * @param {Object} options
     * @property {string} options.type
     * @property {Function} options.correctDependency
     */
    analyzeFileDependencies: function (options) {

        var me = this;

        return me[options.type + 'Dependencies']({
            process: function (file, dependencies) {

                me.dependencyMap[file.path] = dependencies.map(
                    function (dependency) {

                        if (options.correctDependency) {
                            dependency = options.correctDependency(
                                dependency
                            );
                        }

                        return dependency.absolute;

                    }
                );

            }
        });

    },

    /**
     * 替换依赖
     *
     * @param {Object} options
     * @property {string} options.type
     * @property {Function} options.customReplace
     * @property {Function} options.correctDependency
     */
    replaceFileDependencies: function (options) {

        var me = this;
        var hashMap = me.hashMap;
        var dependencyMap = me.dependencyMap;

        var renameFile = me.renameFile;
        var renameDependency = me.renameDependency;

        var getRecursiveHash = function (dependency) {

            // 递归分析出的完整的依赖列表
            var allDependencies = [];

            var recursive = function (dependency) {
                var childDependencies = dependencyMap[dependency];
                if (Array.isArray(childDependencies)) {
                    merge(
                        allDependencies,
                        childDependencies
                    );
                    childDependencies.forEach(recursive);
                }
            };

            recursive(dependency);

            var hash = allDependencies.map(
                function (dependency) {
                    return hashMap[dependency] || '';
                }
            )
            .join('');

            return hash ? md5(new Buffer(hash)) : '';

        };

        return me[options.type + 'Dependencies']({
            process: function (file, dependencies) {

                // 首先自己必须有 hash
                if (!hashMap[file.path]) {
                    return;
                }

                var hash = getRecursiveHash(file.path);
                if (hash) {
                    file.path = renameFile(file, hash);
                }

                if (options.customReplace) {
                    var srcContent = file.contents.toString();
                    var destContent = options.customReplace(srcContent);
                    if (destContent && destContent !== srcContent) {
                        file.contents = new Buffer(destContent);
                    }
                }

            },
            replace: function (dependency) {

                if (options.correctDependency) {
                    dependency = options.correctDependency(dependency);
                }

                var hash = getRecursiveHash(dependency.absolute);
                if (hash) {
                    return renameDependency(dependency, hash);
                }

            }
        });

    }

};




module.exports = Resource;



