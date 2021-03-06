var Q = require('q'), Object_keys = Object.keys;

exports = module.exports = MysqlImpl;

function MysqlImpl() {
}

MysqlImpl.prototype = {
    query: function (sql, val, cb) {
        if (typeof val === 'function') {
            cb = val;
            val = null;
        }

        var ctx = this._context;

        var oldErr = new Error();

        return promiseCallback(Q.Promise(function (resolve, reject) {
            var nonSlave = !/^select/i.test(sql) || /for update;?$/.test(sql);
            ctx.getConnection(function (err, conn) {
                if (err) {
                    return reject(makeError(err, oldErr));
                }
                conn.query(sql, val, function (err, ret) {
                    ctx.releaseConnection(conn);
                    if (err) {
                        reject(makeError(err, oldErr));
                    } else {
                        resolve(ret);
                    }
                });
            }, nonSlave);
        }), cb);
    },
    find: function (tableName, where, options, cb) {
        if (typeof where === 'function') {// tableName, cb
            cb = where;
            where = options = null;
        } else if (typeof options === 'function') { // tableName, where, cb
            cb = options;
            options = null;
        }
        var sql = buildSelectQuery(tableName, where, options);
        if (options && options.progress) {
            var ctx = this._context;
            return Q.Promise(function (resolve, reject, progress) {
                ctx.getConnection(function (err, conn) {
                    if (err) {
                        return reject(makeError(err, oldErr));
                    }
                    conn.query(sql, null).on('error', reject).on('result', progress).on('end', resolve);
                });
            });
        } else {
            return this.query(sql, null, cb);
        }
    },
    findOne: function (tableName, where, options, cb) {
        if (typeof where === 'function') {// tableName, cb
            cb = where;
            where = options = null;
        } else if (typeof options === 'function') { // tableName, where, cb
            cb = options;
            options = null;
        }
        if (!options) {
            options = {limit: 1};
        } else {
            options.limit = 1;
            options.progress = false;
        }
        return promiseCallback(this.query(buildSelectQuery(tableName, where, options), null).then(function (rows) {
            if (!rows.length) throw new Error('NOT_FOUND');
            return rows[0];
        }), cb);
    },
    insert: function (tableName, values, options, cb) {
        if (typeof options === 'function') {
            cb = options;
            options = null;
        }
        var sql = (options && options.ignore ? 'INSERT IGNORE INTO ' : 'INSERT INTO ') + wrapField(tableName),
            fields, arr, subQuery;

        var isArr = values instanceof Array;

        if (options) {
            fields = options.fields;
            subQuery = options.subQuery;
        }

        if (!subQuery) { // insert into tbl(fields) values(...),(...)
            if (isArr) {
                var firstVal = values[0];
                if (firstVal && typeof firstVal === 'object') {
                    if (firstVal instanceof Array) {
                        arr = values;
                    } else {
                        if (!fields) {
                            fields = Object_keys(firstVal);
                        }
                        arr = values.map(function (val) {
                            return fields.map(function (field) {
                                return val[field];
                            });
                        });
                    }
                } else {
                    arr = [values];
                }
            } else if (values === null || typeof values !== 'object') {
                arr = [
                    [values]
                ];
            } else if (fields) { //
                arr = [fields.map(function (field) {
                    return values[field];
                })];
            }
            // else: insert into tbl set field1=val1,...
        }

        if (fields) {
            sql += '(' + fields.map(wrapField).toString() + ')';
        }

        if (arr) {
            sql += ' VALUES (' + arr.map(function (val) {
                return val.map(addslashes);
            }).join('),(') + ')';
            values = null;
        } else if (subQuery) {
            sql += ' ' + buildSubQuery(values);
            values = null;
        } else {
            sql += ' SET ' + serializeMap(values);
        }
        if (options && !options.ignore && options.onDuplicate) {
            sql += ' ON DUPLICATE KEY UPDATE ' + options.onDuplicate;
        }

        return promiseCallback(this.query(sql), cb);
    },
    update: function (tblName, value, options, cb) {
        if (typeof options === 'function') {
            cb = options;
            options = null;
        }
        var sql = 'UPDATE ' + wrapField(tblName) + ' SET ';
        if (options) {
            var fields = options.fields;
            if (fields) {
                if (value instanceof Array) {
                    sql += fields.map(function (field, i) {
                        return wrapField(field) + '=' + addslashes(value[i]);
                    });
                } else if (value && typeof value === 'object') {
                    sql += fields.map(function (field) {
                        return wrapField(field) + '=' + addslashes(value[field]);
                    });
                } else {
                    sql += wrapField(fields[0]) + '=' + addslashes(value);
                }
                value = null;
            } else {
                sql += serializeMap(value);
            }
            if (options.where) {
                sql += ' WHERE ' + buildWhere(options.where);
            }
        } else {
            sql += serializeMap(value);
        }

        return promiseCallback(this.query(sql), cb);
    },
    _buildQuery: buildSelectQuery,
    get: function (key, options) {
        var tbl = this._tableName, idx;
        if (typeof key === 'string' && (idx = key.indexOf('.')) + 1) {
            tbl = key.substr(0, idx);
            key = key.substr(idx + 1);
        }
        var query = {};
        query[this._key] = key;

        options = options || {};
        options.limit = 1;

        return this.find(tbl, query, options).then(function (arr) {
            return arr[0];
        });
    },
    set: function (key, val) {
        var tbl = this._tableName, idx;
        if (typeof key === 'string' && (idx = key.indexOf('.')) + 1) {
            tbl = key.substr(0, idx);
            key = key.substr(idx + 1);
        }
        var keys = Object_keys(val);
        val[this._key] = key;
        return this.insert(tbl, val, {
            onDuplicate: keys.map(function (key) {
                key = wrapField(key);
                return key + '=values(' + key + ')';
            }).join()
        });
    },
    'delete': function (key) {
        var tbl = this._tableName, idx;
        if (typeof key === 'string' && (idx = key.indexOf('.')) + 1) {
            tbl = key.substr(0, idx);
            key = key.substr(idx + 1);
        }
        return this.query('DELETE from ?? where ??=?', [tbl, this._key, key]);
    }
};

function serializeMap(obj) {
    return typeof obj === 'string' ? obj : Object_keys(obj).map(function (field) {
        return wrapField(field) + '=' + addslashes(obj[field]);
    }).toString();
}
function promiseCallback(promise, cb) {
    if (cb) {
        promise = promise.then(function (ret) {
            cb(null, ret)
        }, cb);
    }
    return promise;
}

function makeError(err, oldErr) {
    err = new Error(err.message);
    oldErr = oldErr.stack;
    var newStack = err.stack, idx = newStack.indexOf('\n'), idx2 = newStack.indexOf('\n', idx + 1);
    err.stack = newStack.substr(0, idx) + newStack.substr(idx2) +
        '\n========' + oldErr.substr(oldErr.indexOf('\n'));
    return err;
}

function buildSubQuery(obj) {
    return typeof obj === 'string' ? obj : buildSelectQuery(obj.tableName, obj.where, obj);
}

function buildSelectQuery(tableName, where, options) {
    var fields = options && options.fields;
    if (!fields) {
        fields = '*';
    } else if (typeof fields === 'object') {
        fields = fields.map(wrapField).toString();
    }
    var str = (options && options.distinct ? 'SELECT DISTINCT ' : 'SELECT ') +
        fields + ' FROM ' + wrapField(tableName);

    where = buildWhere(where);
    if (where) {
        str += ' WHERE ' + where;
    }

    if (options) {
        if (options.groupBy)
            str += ' GROUP BY ' + wrapField(options.groupBy);

        if (options.orderBy) {
            str += ' ORDER BY ' + (options.orderBy instanceof Array ?
                options.orderBy.map(wrapField).toString() :
                wrapField(options.orderBy));
            if (options.desc) {
                str += ' DESC';
            }
        }
        if (options.limit)
            str += ' LIMIT ' + (options.limit | 0);
    }
    return str;

}

var ops = {
    '$gt': '>',
    '$lt': '<',
    '$gte': '>=',
    '$lte': '<=',
    '$ne': '!=',
    '$like': ' LIKE ',
    '$nlike': ' NOT LIKE ',
    '$regex': ' REGEXP ',
    '$nregex': ' NOT REGEXP '
}, String = global.String;

function buildWhere(where) {
    if (!where || typeof where !== 'object') return where;
    var keys = Object_keys(where);
    if (!keys.length) return;
    return join(keys.map(function (key) {
        var rule = where[key];
        if (key === '$or') {
            // assert(rule instanceof Array)
            return join(rule.map(buildWhere), 'OR');
        }
        var ret = '`' + key + '`';
        if (rule === null) {
            ret += ' IS NULL';
        } else if (typeof rule === 'object') {
            if (rule instanceof String) {
                ret += '=' + rule;
            } else {
                ret = join(Object_keys(rule).map(function (op) {
                    var tmp = ops[op];
                    if (tmp) {
                        return ret + tmp + addslashes(rule[op]);
                    }
                    if (op === '$in' || op === '$nin') {
                        var val = rule[op];
                        if (!val || typeof  val !== 'object') {
                            return '0';
                        } else if (typeof val === 'object') {
                            return ret + (op === '$in' ? ' IN (' : ' NOT IN (') +
                                (val instanceof Array ? rule[op].map(addslashes).toString() : buildSubQuery(val)) + ')';
                        }
                    } else {
                        return '1';
                    }
                }), 'AND');
            }

        } else {
            ret += '=' + addslashes(rule);
        }
        return ret;
    }), 'AND');


}
function wrapField(field) {
    return typeof field === 'string' ? '`' + field + '`' : String(field);
}

function join(arr, joint) {
    return arr.length === 0 ? '1' : arr.length === 1 ? arr[0] : '(' + arr.join(') ' + joint + ' (') + ')';
}
function addslashes(val) {
    return typeof val === 'string' ? '\'' + String(val).replace(/'/g, '\\\'') + '\'' : String(val);
}