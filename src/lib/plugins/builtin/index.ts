/**
 * Built-in plugins that ship with Agendo.
 * Each plugin is imported statically — no dynamic discovery needed.
 */

import type { AgendoPlugin } from '../types';
import repoSync from './repo-sync';

export const builtinPlugins: AgendoPlugin[] = [repoSync];
