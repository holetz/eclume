const desktop = {
  kicker: 'My settings',
  title: 'Desktop app',
  lead: 'Records meetings and voice notes on the computer and sends them to this server. The installer below already knows this server: you only sign in with your email and password.',
  systems: 'Systems',
  link: {
    title: 'Installed it from somewhere else?',
    text: 'Open the app, choose Link with a code and type this code. It expires in 10 minutes.',
    generate: 'Generate a link code',
  },
  devices: 'Linked computers',
  empty: 'No computer linked yet.',
  unpair: 'The computer stops sending recordings until it logs in again.',
  searching: 'Looking for the installers…',
  download: 'Download <hidden>for {{platform}}</hidden>',
  unpublished: 'The installers have not been published on this server yet.',
  firstTime: 'First time?',
  platform: {
    macos: {
      requirements: 'Apple Silicon and Intel · macOS 15 or newer',
      firstRun: 'On the first opening, right-click the app and choose “Open”, or allow it in System Settings › Privacy & Security › “Open Anyway”. macOS also asks for access to the microphone and to system audio recording.',
    },
    windows: {
      requirements: 'Windows 10 or 11 · 64-bit',
      firstRun: 'Windows may warn that it “protected your PC”. Click “More info” and then “Run anyway”: the installer has no digital signature.',
    },
    linux: {
      requirements: 'x86-64 · PipeWire or PulseAudio',
      firstRun: 'Give the AppImage execute permission (chmod +x) before opening it.',
    },
  },
  type: {
    nsis: '.exe installer',
    msi: '.msi package',
    appimage: 'AppImage',
    deb: '.deb package',
    dmg: '.dmg image',
  },
} as const

export default desktop
