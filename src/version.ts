declare const __BERTH_VERSION__: string | undefined;

export const VERSION: string =
  typeof __BERTH_VERSION__ === 'string' ? __BERTH_VERSION__ : '0.0.0-dev';
