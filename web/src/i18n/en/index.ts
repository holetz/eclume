// Every namespace of this locale, in one chunk loaded on demand (`loadLocale` in ../index.ts).
// Add a new namespace as one import and one entry here, in both locales.
import account from './account'
import auth from './auth'
import common from './common'
import connect from './connect'
import desktop from './desktop'
import environment from './environment'
import errors from './errors'
import importCatalog from './import'
import transcript from './transcript'
import library from './library'
import shared from './shared'
import shell from './shell'
import tokens from './tokens'

const catalogs = { common, errors, shell, shared, auth, account, connect, tokens, environment, desktop, library, transcript, import: importCatalog }

export default catalogs
