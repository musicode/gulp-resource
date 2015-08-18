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
        pattern: /href=['"](?:[^'"]+\.(?:ico|css|less|styl)(?:\?.+)?)['"]/gi,
        match: function (result) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {
                return terms[1].trim();
            }
        }
    },

    {
        pattern: /src=['"](?:[^'"]+\.(?:js|jpg|jpeg|png|gif|webp|ico|cur)(?:\?.+)?)['"]/gi,
        match: function (result) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {
                return terms[1].trim();
            }
        }
    }

];

var cssRules = [

    {
        pattern: /@import\s+['"](?:[^'")]+)['"]/gi,
        match: function (result, file) {
            var terms = result.split(/['"]/);
            if (terms.length === 3) {

                var result = terms[1];

                if (path.extname(result) === '') {
                    return {
                        extname: path.extname(file.path),
                        raw: result
                    };
                }
                else {
                    return result;
                }

            }
        }
    },

    {
        pattern: /url\(['"]?(?:[^'")]+)['"]?\)/gi,
        match: function (result, file) {

            var terms = result.split(/['"]/);
            var result = terms.length === 3
                       ? terms[1]
                       : result.split('(')[1].split(')')[0];

            // background: url( ../images/a.png )
            // 类似这种，还可以两边留空格，因此要 trim
            result = result.trim();

            if (!isAbsolute(result)) {

                if (path.extname(result) === '') {
                    return {
                        extname: path.extname(file.path),
                        raw: result
                    };
                }
                else {
                    return result;
                }

            }
        }

    }

];

/**
 * 计算 md5
 *
 * @inner
 * @param {Buffer} buffer
 * @return {string}
 */
function md5(buffer) {
    return crypto.createHash('md5').update(buffer).digest('hex').slice(0, 10);
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
        createPattern(pattern, 'g'),
        replacement
    );
}

/**
 * 创建一个正则表达式
 *
 * @inner
 * @param {string} pattern
 * @param {string} decorate
 * @return {RegExp}
 */
function createPattern(pattern, decorate) {

    pattern = pattern.replace(/(\{|\}|\(|\)|\[|\]|\$|\.|\/|\?)/g, '\\$1');

    return decorate
         ? new RegExp(pattern)
         : new RegExp(pattern, decorate);

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

    // 这里不用判断是否已添加
    // 比如同一个文件出现下面两句
    //
    // require(
    //     [ 'common/a' ]
    // );
    //
    // require(
    //     [ 'common/a', 'common/b' ]
    // );
    //
    // common/a 无需判断是否存在，因为它出现在不同的匹配块中
    //
    var addDependency = function (dependency) {
        list.push(dependency);
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

                    var extname = dependency.extname;
                    if (extname && extname.length > 1) {

                        var terms = absolute.split('.');
                        terms.pop();
                        terms.push(
                            extname.substr(1)
                        );

                        absolute = terms.join('.');

                    }

                    dependency.raw = cleanQuery(raw);
                    dependency.absolute = cleanQuery(absolute);

                    // 便于替换
                    dependency.match = result;

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
        correct(file, dependencies[i]);
    }

}

/**
 * 过滤一些不需要的依赖，通常在 correctDependencies 之后处理
 *
 * @inner
 * @param {Object} file
 * @param {Array} dependencies
 * @param {Function} filter 返回 true 表示需要过滤
 */
function filterDependencies(file, dependencies, filter) {

    for (var i = dependencies.length - 1; i >= 0; i--) {

        var dependency = dependencies[i];

        // 绝对路径不用处理
        if (isAbsolute(dependency.raw)
            || (filter && filter(file, dependency))
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

    // 按 match 分组
    var group = { };

    dependencies.forEach(function (dependency) {

        var list = group[dependency.match];
        if (!list) {
            list = group[dependency.match] = [ ];
        }

        list.push(dependency);

    });

    util.each(group, function (dependencies, match) {

        destContent = replaceByPattern(
            destContent,
            match,
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
        if (!map[ dependency ]) {

            map[ dependency ] = 1;

            dependencies.push(dependency);

            var childDependencies = dependencyMap[ dependency ];
            if (Array.isArray(childDependencies)) {
                childDependencies.forEach(addDependency);
            }

        }
    };

    addDependency(dependency);

    // 按字母表顺序排序，确保每次顺序一致
    dependencies.sort(
        function (a, b) {
            if (a > b) {
                return 1;
            }
            else if (a < b) {
                return -1;
            }
            else {
                return 0;
            }
        }
    );

    var list = [ ];

    dependencies.forEach(
        function (dependency) {

            var hash = hashMap[ dependency ];
            if (hash) {
                list.push(hash);
            }

        }
    );

    var hash;

    switch (list.length) {
        case 0:
            hash = '';
            break;
        case 1:
            hash = list[0];
            break;
        default:
            hash = md5(new Buffer(list.join('')));
            break;
    }

    return hash;

}

/**
 * 分析 html 文件依赖
 *
 * @inner
 * @param {Object} file
 * @param {Object} instance
 * @param {Object} options
 * @return {Object}
 */
function htmlDependencies(file, instance, options) {

    var dependencies = walkDependencies(
        file,
        instance.htmlRules
    );

    correctDependencies(
        file,
        dependencies,
        instance.correctDependency
    );

    filterDependencies(
        file,
        dependencies,
        instance.filterDependency
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
                    file,
                    dependency,
                    instance.hashMap,
                    instance.dependencyMap
                );
            }
        );
    }

}


/**
 * 分析 css 文件依赖
 *
 * @inner
 * @param {Object} file
 * @param {Object} instance
 * @param {Object} options
 * @return {Object}
 */
function cssDependencies(file, instance, options) {

    var dependencies = walkDependencies(
        file,
        instance.cssRules
    );

    correctDependencies(
        file,
        dependencies,
        instance.correctDependency
    );

    filterDependencies(
        file,
        dependencies,
        instance.filterDependency
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
                    file,
                    dependency,
                    instance.hashMap,
                    instance.dependencyMap
                );
            }
        );

    }
}


/**
 * 分析 amd 文件依赖
 *
 * @inner
 * @param {Object} file
 * @param {Object} instance
 * @param {Object} options
 * @return {Object}
 */
function amdDependencies(file, instance, options) {

    var dependencies = [ ];

    var config = instance.getAmdConfig(file.path);

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

                    if (util.keywords[ resource.id ]) {
                        return;
                    }

                    var resourceId = resolveResourceId(resource.id, module.id);
                    var filePath = resourceIdToFilePath(resourceId, config);

                    if (filePath) {
                        dependencies.push({
                            raw: resource.id,
                            absolute: filePath
                        });
                    }

                });

            });
        }
    );

    correctDependencies(
        file,
        dependencies,
        instance.correctDependency
    );

    filterDependencies(
        file,
        dependencies,
        instance.filterDependency
    );

    if (options.process) {
        options.process(file, dependencies);
    }

    if (options.rename) {

        var replaceRequireResource = config.replaceRequireResource;

        config.replaceRequireResource = function (raw, absolute) {
            return options.rename(
                file,
                {
                    raw: raw,
                    absolute: absolute
                },
                instance.hashMap,
                instance.dependencyMap
            );
        };

        replaceResources(
            fileInfo,
            config
        );

        config.replaceRequireResource = replaceRequireResource;

        file.contents = new Buffer(
            generateFileCode(fileInfo)
        );

    }
}

/**
 * 获取文件对应的遍历器
 *
 * @inner
 * @param {string} filePath
 * @return {Function?}
 */
function getIterator(filePath) {

    var iterator;

    switch (path.extname(filePath).toLowerCase()) {

        case '.css':
        case '.less':
        case '.styl':
        case '.sass':
            iterator = cssDependencies;
            break;

        case '.js':
            iterator = amdDependencies;
            break;

    }

    // 鉴于模板扩展名太多就不 switch 了
    if (!iterator) {
        iterator = htmlDependencies;
    }

    return iterator;

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

    util.extend(this, options);

    this.htmlRules = util.merge(htmlRules, options.htmlRules);
    this.cssRules = util.merge(cssRules, options.cssRules);

    this.hashMap = { };
    this.dependencyMap = { };

    // 缓存递归 MD5
    this.recursiveHashMap = { };

}

Resource.prototype = {

    constructor: Resource,

    /**
     * 自定义处理
     *
     * @param {Function} handler(file, callback)
     */
    custom: function (handler) {

        var me = this;

        return es.map(function (file, callback) {

            handler(file, function () {
                callback(null, file);
            });

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

        return me.custom(function (file, callback) {

            htmlDependencies(file, me, options);

            callback();

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

        return me.custom(function (file, callback) {

            cssDependencies(file, me, options);

            callback();

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

        return me.custom(function (file, callback) {

            amdDependencies(file, me, options);

            callback();

        });
    },

    /**
     * 分析文件的 hash
     */
    analyzeFileHash: function () {

        var me = this;

        return me.custom(function (file, callback) {

            if (file.isBuffer()) {

                var filePath = file.path;
                var hash = me.hashMap[ filePath ];

                if (!hash) {
                    hash = md5(file.contents);
                    me.hashMap[ filePath ] = hash;
                }

            }

            callback();

        });

    },

    /**
     * 分析文件的依赖
     *
     * 只能分析 html css amd 三种文件
     *
     */
    analyzeFileDependencies: function () {

        var me = this;

        return me.custom(function (file, callback) {

            var iterator = getIterator(file.path);

            if (iterator) {
                iterator(file, me, {
                    process: function (file, dependencies) {

                        if (dependencies.length > 0) {
                            me.dependencyMap[ file.path ] = dependencies.map(
                                function (dependency) {
                                    return dependency.absolute;
                                }
                            );
                        }

                    }
                });
            }

            callback();

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

        return me.custom(function (file, callback) {

            var iterator = getIterator(file.path);

            if (iterator) {
                iterator(file, me, {
                    process: function (file, dependencies) {

                        if (options.customReplace) {
                            var srcContent = file.contents.toString();
                            var destContent = options.customReplace(file, srcContent);
                            if (destContent && destContent !== srcContent) {
                                file.contents = new Buffer(destContent);
                            }
                        }

                    },
                    rename: function (file, dependency) {

                        var prefix = './';

                        // "./a.js" 重命名为 "./a_123.js"
                        // 但是 path.join('.', 'a.js') 会变成 a.js

                        if (dependency.raw.indexOf(prefix) !== 0) {
                            prefix = '';
                        }

                        var dependencyPath = me.renameDependency(
                            file,
                            dependency,
                            getRecursiveHash(
                                dependency.absolute,
                                me.hashMap,
                                me.dependencyMap
                            )
                        );

                        if (prefix && dependencyPath.indexOf(prefix) !== 0) {
                            dependencyPath = prefix + dependencyPath;
                        }

                        return dependencyPath;

                    }
                });
            }

            callback();

        });

    },

    /**
     * 生成文件名带有哈希值的文件
     */
    renameFiles: function () {

        var me = this;

        return me.custom(function (file, callback) {

            var hashFilePath = me.getHashFilePath(file);

            if (hashFilePath) {
                file.path = hashFilePath;
            }

            callback();

        });

    },

    /**
     * 获得哈希后的文件路径
     *
     * @param {Object} file
     * @return {string}
     */
    getHashFilePath: function (file) {

        var me = this;

        var hash = me.getFileHash(file.path, me.hashMap, me.dependencyMap, true);

        if (hash) {
            return me.renameFile(file, hash);
        }

    },

    /**
     * 获得文件的哈希（递归哈希）
     *
     * @param {string} filePath
     * @param {Object=} hashMap
     * @param {Object=} dependencyMap
     * @param {boolean=} cache 是否缓存，不缓存
     * @return {string}
     */
    getFileHash: function (filePath, hashMap, dependencyMap, cache) {

        var me = this;
        var recursiveHashMap = me.recursiveHashMap;

        var hash = recursiveHashMap[ filePath ];

        if (!cache || typeof hash !== 'string') {
            hash = getRecursiveHash(
                filePath,
                hashMap,
                dependencyMap
            );
        }

        if (cache) {
            recursiveHashMap[ filePath ] = hash;
        }

        return hash;

    },

    /**
     * 编译 amd 模块
     */
    buildAmdModules: function () {

        var me = this;

        return me.custom(function (file, callback) {

            amdDeploy({
                file: file.path,
                content: file.contents.toString(),
                config: me.getAmdConfig(file.path),
                callback: function (code) {

                    file.contents = new Buffer(code);
                    callback();

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

            console.log('[INFO][amd id parse error]');
            console.log(match);
            console.log('');

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
        )[0];
    }

};




module.exports = Resource;

