// ngo screens (being built).
import { h, pageHead, empty } from './core.js';
export function routes(register) {
  register('/ngo', { title: 'ngo', roles: ['ngo'], render: () => h('section', pageHead('Coming soon'), empty('These screens are being built.', null)) });
}
