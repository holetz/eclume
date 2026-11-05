// Every namespace of this locale, in one chunk loaded on demand (`loadLocale` in ../index.ts).
// Add a new namespace as one import and one entry here, in both locales.
import account from './account'
import auth from './auth'
import common from './common'
import connect from './connect'
import desktop from './desktop'
import environment from './environment'
import errors from './errors'
import tags from './tags'
import collections from './collections'
import organize from './organize'
import people from './people'
import search from './search'
import importCatalog from './import'
import transcript from './transcript'
import library from './library'
import shared from './shared'
import shell from './shell'
import tokens from './tokens'
import type en from '../en'

const catalogs: { [K in keyof typeof en]: unknown } = {
  common,
  errors,
  shell,
  shared,
  auth,
  account,
  connect,
  tokens,
  environment,
  desktop,
  library,
  transcript,
  import: importCatalog,
  search,
  people,
  organize,
  collections,
  tags,
}

export default catalogs
