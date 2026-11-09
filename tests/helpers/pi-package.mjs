import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

// npm globals nest Pi's dependencies; the pi.dev managed install hoists them beside Pi.
export function piDependency(root, name, file) {
  const nested = resolve(root, 'node_modules', name, file);
  return existsSync(nested) ? nested : resolve(dirname(dirname(root)), name, file);
}
