/*
 * Minimal browser globals so the vendored libraries can be imported by the
 * Node scripts in this folder. The browser app does not use this file.
 *
 * js/lib/noble-bls.js opens with:
 *   var globals = typeof global === 'undefined' ? self : global;
 * and later declares `var global` further down the same module. That
 * declaration is hoisted, so `global` reads as undefined on the first line and
 * the expression falls through to `self`, which Node does not define. Defining
 * `self` and `window` up front satisfies both that line and the `window` check
 * further down.
 *
 * Import this before any module that pulls in the vendored libraries; ES module
 * evaluation follows import order, so it runs first.
 */

if (typeof globalThis.self === 'undefined') globalThis.self = globalThis;
if (typeof globalThis.window === 'undefined') globalThis.window = globalThis;
