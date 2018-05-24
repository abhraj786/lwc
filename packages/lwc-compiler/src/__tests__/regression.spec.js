const { compile } = require('../index');
const { fixturePath, readFixture, pretify } = require('./utils');

describe('resgression test', () => {
    it('#743 - Object rest spread throwing', async () => {
        const actual = `const base = { foo: true }; const res = { ...base, bar: false };`;
        const expected = `function _objectSpread(target) { for (var i = 1; i < arguments.length; i++) { var source = arguments[i] != null ? arguments[i] : {}; var ownKeys = Object.keys(source); if (typeof Object.getOwnPropertySymbols === 'function') { ownKeys = ownKeys.concat(Object.getOwnPropertySymbols(source).filter(function (sym) { return Object.getOwnPropertyDescriptor(source, sym).enumerable; })); } ownKeys.forEach(function (key) { _defineProperty(target, key, source[key]); }); } return target; }
        function _defineProperty(obj, key, value) { if (key in obj) { Object.defineProperty(obj, key, { value: value, enumerable: true, configurable: true, writable: true }); } else { obj[key] = value; } return obj; }

        const base = {
            foo: true
        };

        const res = _objectSpread({}, base, {
            bar: false
        });`;

        const { code } = await compile('/x/foo/foo.js', {
            sources: {
                '/x/foo/foo.js': actual,
            },
        });

        expect(pretify(code)).toBe(pretify(expected));
    });
});

describe('smoke test for babel transform', () => {
    it('should transpile none stage-4 syntax features in none-compat', async () => {
        const { code } = await compile(
            fixturePath('namespaced_folder/babel/babel.js'),
            {
                mode: 'dev'
            }
        );
        expect(pretify(code)).toBe(
            pretify(readFixture('expected-babel.js')),
        );
    });

    it('should transpile back to es5 in compat mode', async () => {
        const { code } = await compile(
            fixturePath('namespaced_folder/babel/babel.js'), { mode: 'compat' }
        );

        expect(pretify(code)).toBe(
            pretify(readFixture('expected-babel-compat.js')),
        );
    });
});