import { useMutation, useQueryClient } from '@tanstack/react-query'
import { useId } from 'react'
import { useTranslation } from 'react-i18next'
import { api, type Schemas } from '../../api/client'
import { errorMessage, unwrap } from '../../api/problem'
import { ME_KEY, useMe } from '../../app/session'
import { setLocale } from '../../i18n'
import { browserLocale, type Locale } from '../../i18n/locale'
import styles from './Account.module.css'

type Me = Schemas['Me']

/** Each language named in itself, the same in every catalog. */
const ENDONYMS: Record<Locale, string> = {
  en: 'English',
  'pt-BR': 'Português (Brasil)',
}

/** The interface language of the account: the browser's (`null`) or one of the product locales. */
export function LocaleSection() {
  const id = useId()
  const { t } = useTranslation('account')
  const queryClient = useQueryClient()
  const me = useMe()
  const update = useMutation({
    mutationFn: (locale: Locale | null) => unwrap(api.PATCH('/api/v1/me/locale', { body: { locale } })),
    onSuccess: (result) => {
      queryClient.setQueryData<Me | null>(ME_KEY, (current) =>
        current ? { ...current, user: { ...current.user, locale: result.locale } } : current,
      )
      void setLocale(result.locale ?? browserLocale())
    },
  })
  const stored = me.data?.user.locale ?? null
  const value = update.isPending ? (update.variables ?? '') : (stored ?? '')

  return (
    <section className={`panel ${styles.form}`} aria-labelledby={`${id}-title`}>
      <h4 id={`${id}-title`}>{t('locale.title')}</h4>
      <div className="field">
        <label htmlFor={id}>{t('locale.label')}</label>
        <select
          id={id}
          className="input"
          value={value}
          disabled={update.isPending || !me.data}
          aria-describedby={`${id}-hint`}
          onChange={(event) => update.mutate(event.target.value === '' ? null : (event.target.value as Locale))}
        >
          <option value="">{t('locale.browser')}</option>
          {(Object.keys(ENDONYMS) as Locale[]).map((locale) => (
            <option key={locale} value={locale} lang={locale}>
              {ENDONYMS[locale]}
            </option>
          ))}
        </select>
        <span id={`${id}-hint`} className="field-hint">
          {t('locale.hint')}
        </span>
      </div>
      {update.isSuccess && (
        <p className="alert alert-success" role="status">
          {t('locale.saved')}
        </p>
      )}
      {update.isError && (
        <p className="alert alert-error" role="alert">
          {errorMessage(update.error)}
        </p>
      )}
    </section>
  )
}
