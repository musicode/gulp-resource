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
var filePathToResourceId = require('amd-deploy/lib/filePathToResourceId');
var resourceIdToFilePath = require('amd-deploy/lib/resourceIdToFilePath');
var generateFileCode = require('amd-deploy/lib/generateFileCode');
var parseFactoryResources = require('amd-deploy/lib/parseFactoryResources');
var replaceResources = require('amd-deploy/lib/replaceResources');
var readRequireConfig = require('amd-deploy/lib/readRequireConfig');
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
 * 清掉 url 的 query 后缀
 *
 * @inner
 * @param {string} url
 * @return {string}
 */
function cleanQuery(url) {

    var query = path.extname(url).split('?')[1];

    if (query && query.length > 0) {

        return url.substr(
            0,
            url.length - (query.length + 1)
        );

    }

    return url;

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
    return content.replace(
        createPattern(pattern),
        replacement
    );
}

/**
 * 创建一个正则表达式
 *
 * @inner
 * @param {string} pattern
 * @return {RegExp}
 */
function createPattern(pattern) {
    pattern = pattern.replace(/(\{|\}|\(|\)|\[|\]|\$|\.|\/|\?)/g, '\\$1');
    return new RegExp(pattern, 'g');
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

                var dependencies = parser.match(result, file);
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
                    var absolute = dependency.absolute;

                    if (!absolute) {
                        absolute = /^(?:\w|\.(?:\.)?)/.test(raw)
                                 ? path.join(directory, raw)
                                 : raw;
                    }

                    dependency.raw = cleanQuery(raw);
                    dependency.absolute = cleanQuery(absolute);

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
 * @param {Object} file
 * @param {Array} dependencies
 * @param {Function} correct
 */
function correctDependencies(file, dependencies, correct) {

    if (!correct) {
        return;
    }

    for (var i = dependencies.length - 1; i >= 0; i--) {
        correct(dependencies[i], file);
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
 * @param {Function} rename
 */
function renameDependencies(file, dependencies, rename) {

    var srcContent = file.contents.toString();
    var destContent = srcContent;

    // 按 text 分组
    var group = { };

    dependencies.forEach(function (dependency) {

        var list = group[dependency.text];
        if (!list) {
            list = group[dependency.text] = [ ];
        }

        list.push(dependency);

    });

    each(group, function (text, dependencies) {

        destContent = replaceByPattern(
            destContent,
            text,
            function (result) {

                dependencies.forEach(function (dependency) {

                    var replacement = rename(dependency);
                    if (replacement) {
                        result = replaceByPattern(
                            result,
                            dependency.raw,
                            replacement
                        );
                    }

                });

                return result;

            }
        );

    });

    if (srcContent !== destContent) {
        file.contents = new Buffer(destContent);
    }

}

/**
 * 获取递归计算的 md5
 *
 * @inner
 * @param {string} dependency
 * @param {Object} hashMap
 * @param {Object} dependencyMap
 * @return {string}
 */
function getRecursiveHash(dependency, hashMap, dependencyMap) {

    // 递归分析出的完整的依赖列表
    var dependencies = [ ];
    var map = { };

    var addDependency = function (dependency) {
        // 要避免循环依赖
        if (!map[dependency]) {

            map[dependency] = 1;

            dependencies.push(dependency);

            var childDependencies = dependencyMap[dependency];
            if (Array.isArray(childDependencies)) {
                childDependencies.forEach(addDependency);
            }

        }
    };

    addDependency(dependency);

    var hash = dependencies.map(
        function (dependency) {

            var hash = hashMap[dependency];

            if (!hash && path.extname(dependency) !== '.html') {

                if (path.relative(
                        '/Users/zhujl/github/www-fe/asset',
                        dependency
                    ).indexOf('..') < 0
                ) {
                    console.log(
                        '[hash not found]' + dependency,
                        Object.keys(hashMap).length
                    );
                }

            }

            return hash || '';

        }
    )
    .join('');

    return hash ? md5(new Buffer(hash)) : '';

}


/**
 *
 * @param {Object} options
 * @property {Array} options.htmlRules
 * @property {Array} options.cssRules
 * @property {Function} options.getAmdConfig 获取 AMD 配置，会传入当前处理的文件路径
 * @property {Function} options.renameFile 重命名文件，比如加上 md5
 * @property {Function} options.renameDependency 重命名依赖，比如加上 md5
 * @property {Function=} options.filterDependency 过滤非法依赖，比如 src/img/${a}.jpg
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
     * @property {Function} options.rename
     */
    htmlDependencies: function (options) {

        var me = this;

        return es.map(function (file, callback) {

            var dependencies = walkDependencies(
                file,
                me.htmlRules
            );

            correctDependencies(
                file,
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

            if (options.rename) {
                renameDependencies(
                    file,
                    dependencies,
                    function (dependency) {
                        return options.rename(
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
     * @property {Function} options.rename
     */
    cssDependencies: function (options) {

        var me = this;

        return es.map(function (file, callback) {

            var dependencies = walkDependencies(
                file,
                me.cssRules
            );

            correctDependencies(
                file,
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

            if (options.rename) {

                renameDependencies(
                    file,
                    dependencies,
                    function (dependency) {
                        return options.rename(
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
     * @property {Function} options.rename
     */
    amdDependencies: function (options) {

        var me = this;

        var replace = options.rename;

        return es.map(function (file, callback) {

            var dependencies = [ ];

            var config = me.getAmdConfig(file.path);

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
                file,
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

                config.replaceRequireResource = function (raw, absolute) {
                    return replace({
                        raw: raw,
                        absolute: absolute
                    });
                };

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
     */
    analyzeFileDependencies: function (options) {

        var me = this;

        return me[options.type + 'Dependencies']({
            process: function (file, dependencies) {

                me.dependencyMap[file.path] = dependencies.map(
                    function (dependency) {
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
     */
    replaceFileDependencies: function (options) {

        var me = this;
        var hashMap = me.hashMap;
        var dependencyMap = me.dependencyMap;

        return me[options.type + 'Dependencies']({
            process: function (file, dependencies) {

                if (options.customReplace) {
                    var srcContent = file.contents.toString();
                    var destContent = options.customReplace(srcContent);
                    if (destContent && destContent !== srcContent) {
                        file.contents = new Buffer(destContent);
                    }
                }

                file.path = me.renameFile(
                    file,
                    getRecursiveHash(file.path, hashMap, dependencyMap)
                );

            },
            rename: function (dependency) {

                return me.renameDependency(
                    dependency,
                    getRecursiveHash(dependency.absolute, hashMap, dependencyMap)
                );

            }
        });

    },

    /**
     * 编译 amd 模块
     */
    buildAmdModules: function () {

        var me = this;

        return es.map(function (file, callback) {

            amdDeploy({
                file: file.path,
                content: file.contents.toString(),
                config: me.getAmdConfig(file.path),
                callback: function (code) {

                    file.contents = new Buffer(code);

                    callback(null, file);

                }
            });

        });

    },

    /**
     * 解析 amd 依赖
     *
     * @param {string} filePath 文件路径
     * @param {string} match 文件中匹配到的原始字符串
     * @param {string} literal 从 match 中抽离出的符合 id 规则的字面量
     * @return {Array.<string>}
     */
    parseAmdDependencies: function (filePath, match, literal) {

        // literal 可能是 'moduleId'、'[ "module1", "module2" ]'、xxx（非法 js 变量）

        literal = literal.trim();

        var resources;

        try {
            var factory = new Function('return ' + literal);
            resources = factory();
        }
        catch (e) {
            console.error('[INFO][amd id parse error]' + match);
            resources = literal;
        }

        if (!resources) {
            return;
        }

        if (!Array.isArray(resources)) {
            resources = [ resources ];
        }

        var me = this;
        var config = me.getAmdConfig(filePath);

        var result = [ ];

        resources.forEach(function (resourceId) {

            var filePath = resourceIdToFilePath(
                resourceId,
                config
            );

            if (filePath) {
                result.push({
                    amd: true,
                    raw: resourceId,
                    absolute: filePath
                });
            }

        });

        return result;

    },

    /**
     * 解析文本中的 require.config，比如写在 html
     *
     * @param {string} content
     * @return {Array}
     */
    parseAmdConfig: function (content) {
        return readRequireConfig(content);
    },

    /**
     * 文件路径转为资源 ID
     *
     * @param {string} filePath
     * @return {string}
     */
    filePathToResourceId: function (filePath) {
        return filePathToResourceId(
            filePath,
            this.getAmdConfig(filePath)
        );
    }

};




module.exports = Resource;



