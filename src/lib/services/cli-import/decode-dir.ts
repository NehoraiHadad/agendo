/**
 * Decode a Claude projects directory name back to an absolute path.
 * e.g. "-home-ubuntu-projects-agendo" → "/home/ubuntu/projects/agendo"
 */
export function decodeDirName(dirName: string): string {
  return dirName.replace(/^-/, '/').replaceAll('-', '/');
}
