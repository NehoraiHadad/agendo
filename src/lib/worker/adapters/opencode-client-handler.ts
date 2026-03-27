// OpenCode's ACP client handler is the shared AcpClientHandler class.
// This file is kept for backwards-compatibility — adapters import from here.
export {
  AcpClientHandler as OpenCodeClientHandler,
  extractMessage,
} from '@/lib/worker/adapters/base-acp-client-handler';
