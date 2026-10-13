// vendor screens (being built).
import { h, pageHead, empty } from './core.js';
export function routes(register) {
  register('/vendor', { title: 'vendor', roles: ['vendor'], render: () => h('section', pageHead('Coming soon'), empty('These screens are being built.', null)) });
}
