import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'dev.sketch.mobile',
  appName: 'Sketch',
  webDir: 'dist',
  backgroundColor: '#141414',
  android: {
    allowMixedContent: false,
  },
  server: {
    androidScheme: 'https',
  },
}

export default config
