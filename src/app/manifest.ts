import type { MetadataRoute } from 'next';

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'agenDo',
    short_name: 'agenDo',
    description: 'CLI agent orchestration and task management',
    start_url: '/',
    display: 'standalone',
    orientation: 'portrait',
    theme_color: '#0d0d0e',
    background_color: '#0d0d0e',
    categories: ['productivity', 'developer tools'],
    icons: [
      { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png' },
      { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png' },
      { src: '/icons/apple-touch-icon.png', sizes: '180x180', type: 'image/png' },
    ],
  };
}
