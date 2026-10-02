/**
 * A library's component CSS, compiled into native sheets when the app opts the package in with
 * `libraryStyles`. Three layers, because the list has a way to travel: the preset records it on
 * the transformer config, the transform worker carries it into the bundle's transform options,
 * and the transformer reads it from there and compiles each declared component's `styles` into
 * the sheet on its class, as it does for the app's own components.
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createRequire } from 'node:module';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { transformAngular } = require('@ng-native/metro/angular-transform.cjs') as {
  transformAngular: (
    src: string,
    filename: string,
    options?: { dev?: boolean; platform?: string; libraryStyles?: string[] },
  ) => { code: string };
};
const { transformAngularFileSync } = require('@oxc-angular/vite/api') as {
  transformAngularFileSync: (src: string, file: string, options: object) => { code: string };
};

/**
 * A library's component as npm ships it: partial-compiled, its CSS written for a browser. Plain
 * JavaScript, as a published library is: the Angular stage leaves TypeScript syntax in place.
 */
function partial(source: string, file: string): string {
  const { code } = transformAngularFileSync(source, file, { compilationMode: 'partial' });
  assert.match(code, /ɵɵngDeclareComponent/, 'the fixture really is partial-compiled');
  return code;
}

const CHIP = `import {Component, input} from '@angular/core';
@Component({
  selector: 'acme-chip',
  template: '<text>chip</text>',
  host: { '[attr.data-tone]': 'tone()' },
  styles: [
    ':host { display: inline-flex; padding: 4px 8px; background: var(--surface) }',
    ':host([data-tone="warm"]) { background: #fa7319; color: white }',
  ],
})
export class Chip {
  tone = input('cool');
  /** An input called type, which a reader of the declaration must not take for the class. */
  type = input('solid');
}`;

const FILE = '/app/node_modules/@acme/ui/fesm2022/acme-ui.mjs';

/** What the build prints while `run` transforms, and what it returns. */
function warned<T>(run: () => T): { result: T; warnings: string[] } {
  const warnings: string[] = [];
  const original = console.warn;
  console.warn = (message: string) => void warnings.push(message);
  try {
    return { result: run(), warnings };
  } finally {
    console.warn = original;
  }
}

interface Rule {
  declarations: object;
  compounds: { attributes?: unknown[] }[];
  deferred?: unknown[];
}

/** The sheet the transform hung off `className`, parsed, or null when it hung none. */
function sheetOf(code: string, className: string): { rules: Rule[] } | null {
  const match = new RegExp(`${className}\\["ɵnativeStyles"\\] = (\\{.*?\\});\\n`).exec(code);
  return match ? JSON.parse(match[1]!) : null;
}

describe("a library's component CSS, opted in", () => {
  const source = partial(CHIP, FILE);

  it('compiles the CSS as shipped into a sheet on the class, host attribute rules included', () => {
    const { result, warnings } = warned(() =>
      transformAngular(source, FILE, { dev: false, platform: 'ios', libraryStyles: ['@acme/ui'] }),
    );
    assert.deepEqual(warnings, []);
    assert.match(result.code, /ɵɵdefineComponent/, 'the linker still ran');
    assert.doesNotMatch(result.code, /_nghost-%COMP%/, 'the shimmed CSS is still stripped');
    const sheet = sheetOf(result.code, 'Chip')!;
    assert.ok(sheet, 'the sheet is on the class');
    assert.deepEqual(
      sheet.rules.map((rule) => rule.declarations),
      [
        { display: 'flex', paddingTop: 4, paddingRight: 8, paddingBottom: 4, paddingLeft: 8 },
        { backgroundColor: 'rgb(250, 115, 25)', color: 'rgb(255, 255, 255)' },
      ],
    );
    assert.deepEqual(
      sheet.rules[1]!.compounds,
      [
        {
          classes: [],
          host: true,
          attributes: [{ name: 'data-tone', operator: 'equal', value: 'warm' }],
        },
      ],
      'the :host([attr]) rule is read from the CSS before the linker shimmed it',
    );
    assert.deepEqual(
      sheet.rules[0]!.deferred,
      [{ props: ['backgroundColor'], kind: 'color', reference: '--surface' }],
      "a token in the library's background is read on device",
    );
  });

  it('compiles it in a dev build as well, beside the CSS the dev build keeps', () => {
    const { code } = transformAngular(source, FILE, {
      dev: true,
      platform: 'ios',
      libraryStyles: ['@acme/ui'],
    });
    assert.match(code, /_nghost-%COMP%/);
    assert.ok(sheetOf(code, 'Chip'));
  });

  it('leaves a web build alone, where the browser applies the CSS itself', () => {
    const { code } = transformAngular(source, FILE, {
      platform: 'web',
      libraryStyles: ['@acme/ui'],
    });
    assert.match(code, /_nghost-%COMP%/);
    assert.equal(sheetOf(code, 'Chip'), null);
  });

  it('leaves a package that is not on the list as before: linked, stripped, no sheet', () => {
    const none = transformAngular(source, FILE, { dev: false, platform: 'ios' }).code;
    const other = transformAngular(source, FILE, {
      dev: false,
      platform: 'ios',
      libraryStyles: ['@acme/other'],
    }).code;
    for (const code of [none, other]) {
      assert.match(code, /ɵɵdefineComponent/);
      assert.doesNotMatch(code, /ɵnativeStyles/);
    }
  });

  it('warns for what native cannot express, naming the file, the line and the class', () => {
    const file = '/app/node_modules/x-ui/ui.mjs';
    const hover = partial(
      `import {Component} from '@angular/core';
       @Component({selector: 'x-b', template: '<text>b</text>', styles: ['.b { color: red; -webkit-font-smoothing: antialiased }\\n.b:hover { color: blue }']})
       export class B {}`,
      file,
    );
    const { result, warnings } = warned(() =>
      transformAngular(hover, file, { dev: false, platform: 'ios', libraryStyles: ['x-ui'] }),
    );
    const line = hover.slice(0, hover.indexOf('.b { color')).split('\n').length;
    assert.equal(warnings.length, 2);
    assert.match(
      warnings[0]!,
      new RegExp(`^\\[angular-native\\] ${file}:${line} \\(B\\): dropped '-webkit-font-smoothing'`),
    );
    assert.match(warnings[1]!, /\(B\): dropped a rule: ':hover' is not supported/);
    assert.deepEqual(
      sheetOf(result.code, 'B')!.rules.map((rule) => rule.declarations),
      [{ color: 'rgb(255, 0, 0)' }],
      'the rest of the rule still applies',
    );
  });

  it('finds the package under a pnpm path, and the one the file is in rather than the one above', () => {
    const nested =
      '/app/node_modules/.pnpm/@acme+ui@1.0.0/node_modules/@acme/ui/fesm2022/acme-ui.mjs';
    const listed = transformAngular(partial(CHIP, nested), nested, {
      dev: false,
      platform: 'ios',
      libraryStyles: ['@acme/ui'],
    }).code;
    assert.ok(sheetOf(listed, 'Chip'));

    const inner = '/app/node_modules/@acme/ui/node_modules/x-dep/dep.mjs';
    const dependency = transformAngular(partial(CHIP, inner), inner, {
      dev: false,
      platform: 'ios',
      libraryStyles: ['@acme/ui'],
    }).code;
    assert.equal(
      sheetOf(dependency, 'Chip'),
      null,
      'a dependency of the library is not the library',
    );
  });

  it("finds a linked workspace package by its package.json's name", () => {
    const root = mkdtempSync(path.join(tmpdir(), 'linked-ui-'));
    try {
      const lib = path.join(root, 'libs', 'ui');
      mkdirSync(path.join(lib, 'src'), { recursive: true });
      writeFileSync(path.join(lib, 'package.json'), '{ "name": "@acme/linked-ui" }');
      const file = path.join(lib, 'src', 'chip.mjs');
      writeFileSync(file, '');
      const code = transformAngular(partial(CHIP, file), file, {
        dev: false,
        platform: 'ios',
        libraryStyles: ['@acme/linked-ui'],
      }).code;
      assert.ok(sheetOf(code, 'Chip'));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads the CSS as the literal means it, escapes included', () => {
    const file = '/app/node_modules/x-ui/quoted.mjs';
    const quoted = partial(
      `import {Component} from '@angular/core';
       @Component({selector: 'x-q', template: '<text>q</text>', styles: ['.q[data-k="a b"] {\\n  color: red;\\n}\\n.q::after { content: "\\\\201C" }']})
       export class Q {}`,
      file,
    );
    assert.match(quoted, /\\n/, 'the literal carries escaped line breaks');
    const { result, warnings } = warned(() =>
      transformAngular(quoted, file, { dev: false, platform: 'ios', libraryStyles: ['x-ui'] }),
    );
    const sheet = sheetOf(result.code, 'Q')!;
    assert.deepEqual(sheet.rules[0]!.declarations, { color: 'rgb(255, 0, 0)' });
    assert.deepEqual(sheet.rules[0]!.compounds[0]!.attributes, [
      { name: 'data-k', operator: 'equal', value: 'a b' },
    ]);
    assert.equal(warnings.length, 1, "the pseudo-element rule is refused, as the app's would be");
    assert.match(warnings[0]!, /pseudo-elements/);
  });

  it('gives each component in a file its own sheet, and one with no styles none', () => {
    const file = '/app/node_modules/x-ui/pair.mjs';
    const pair = partial(
      `import {Component} from '@angular/core';
       @Component({selector: 'x-a', template: '<text>a</text>', styles: ['.a { color: red }']})
       export class A {}
       @Component({selector: 'x-plain', template: '<text>plain</text>'})
       export class Plain {}
       @Component({selector: 'x-c', template: '<text>c</text>', styles: ['.c { color: blue }', '.d { color: green }']})
       export class C {}`,
      file,
    );
    const { code } = transformAngular(pair, file, {
      dev: false,
      platform: 'ios',
      libraryStyles: ['x-ui'],
    });
    assert.deepEqual(
      sheetOf(code, 'A')!.rules.map((rule) => rule.declarations),
      [{ color: 'rgb(255, 0, 0)' }],
    );
    assert.equal(sheetOf(code, 'Plain'), null);
    assert.deepEqual(
      sheetOf(code, 'C')!.rules.map((rule) => rule.declarations),
      [{ color: 'rgb(0, 0, 255)' }, { color: 'rgb(0, 128, 0)' }],
    );
  });
});

describe('how the list reaches the transformer', () => {
  /** Our worker in front of a stand-in for Expo's that hands back the options it was given. */
  function worker() {
    const root = mkdtempSync(path.join(tmpdir(), 'library-styles-worker-'));
    const dir = path.join(root, 'node_modules/@expo/metro-config/build/transform-worker');
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      path.join(dir, 'transform-worker.js'),
      'module.exports = { transform: (c, p, f, d, options) => options };',
    );
    const ours = require('@ng-native/metro/transform-worker.cjs') as {
      transform(...args: unknown[]): { customTransformOptions?: Record<string, unknown> };
    };
    const upstream = path.relative(root, path.join(dir, 'transform-worker.js'));
    const run = (config: object, options: object) =>
      ours.transform(
        { angularNativeUpstreamTransformer: upstream, ...config },
        root,
        path.join(root, 'app.ts'),
        Buffer.from(''),
        options,
      );
    return { run, cleanup: () => rmSync(root, { recursive: true, force: true }) };
  }

  it("the worker puts the preset's list into the bundle's customTransformOptions", () => {
    const { run, cleanup } = worker();
    try {
      const options = run(
        { angularNativeLibraryStyles: ['@acme/ui'] },
        { platform: 'ios', customTransformOptions: { dom: 'kept' } },
      );
      assert.deepEqual(options.customTransformOptions, {
        dom: 'kept',
        angularNativeLibraryStyles: ['@acme/ui'],
      });
    } finally {
      cleanup();
    }
  });

  it('the worker leaves the options alone when the preset recorded no list', () => {
    const { run, cleanup } = worker();
    try {
      const given = { platform: 'ios', customTransformOptions: { dom: 'kept' } };
      assert.equal(run({}, given), given);
      assert.equal(run({ angularNativeLibraryStyles: [] }, given), given);
    } finally {
      cleanup();
    }
  });

  it('the transformer compiles a listed library from customTransformOptions, end to end', () => {
    const transformer = require('@ng-native/metro/transformer.cjs') as {
      transform(params: object): { ast: object };
    };
    const generate = (require('@babel/generator') as { default: Function }).default;
    const run = (customTransformOptions?: object) =>
      generate(
        transformer.transform({
          filename: FILE,
          src: partial(CHIP, FILE),
          options: { dev: false, platform: 'ios', projectRoot: '/app', customTransformOptions },
          plugins: [],
        }).ast,
      ).code as string;
    assert.match(run({ angularNativeLibraryStyles: ['@acme/ui'] }), /Chip\["ɵnativeStyles"\]/);
    assert.doesNotMatch(run(undefined), /ɵnativeStyles/);
  });
});
