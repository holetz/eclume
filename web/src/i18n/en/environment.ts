const environment = {
  kicker: 'My settings',
  title: 'Environment',
  lead: 'Settings for this browser. They apply here, without changing your account or the other computers and phones.',
  look: {
    title: 'Appearance',
    theme: 'Theme',
    themes: { system: 'System', light: 'Light', dark: 'Dark' },
    density: 'Density',
    densityHint: 'Compact tightens the space between blocks to fit more on the screen; the text size does not change.',
    densities: { comfortable: 'Comfortable', compact: 'Compact' },
    motion: 'Motion',
    motionHint: 'Reduce turns off animations and transitions, even if the system does not ask for it.',
    motions: { system: 'Follow the system', reduce: 'Reduce' },
  },
  agenda: {
    title: 'Agenda',
    workHours: 'Working hours',
    start: 'Start',
    end: 'End',
    workHint: 'The band highlighted in the library week, which it shows in full on opening. The default is {{start}} to {{end}}.',
    opening: 'Open the library in',
    openingHint: 'Last used goes back to the view and the filters of your last visit.',
    openings: { ultima: 'Last used', semana: 'Week', mes: 'Month', lista: 'List' },
  },
  notices: {
    title: 'Notifications',
    toggle: 'Notify in the browser when a recording finishes processing',
    unsupported: 'This browser does not show system notifications for this address.',
    blocked: 'The browser blocked notifications for this site: allow them in the site permissions and turn this on again.',
    hint: 'Summary ready, ready without a summary or failed, with the eclume tab open. With the tab in the background, its title also counts the notifications.',
  },
  keys: {
    title: 'Keyboard shortcuts',
    wheel: 'mouse wheel',
    help: 'Opens the help for the page you are on',
    close: 'Closes the help or the open dialog',
    zoom: 'Zooms the hours in or out in the library week',
  },
  restore: 'Restore the defaults',
  restored: 'Everything is back to the default.',
} as const

export default environment
