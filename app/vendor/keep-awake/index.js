import { registerPlugin } from '@capacitor/core';
const KeepAwake = registerPlugin('KeepAwake', {
    web: () => import('./web.js').then((m) => new m.KeepAwakeWeb()),
});
export * from './definitions.js';
export { KeepAwake };