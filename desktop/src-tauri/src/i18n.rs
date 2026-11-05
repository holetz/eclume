//! Supported desktop locales and preference resolution.

use serde::Serialize;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub enum Locale {
    #[serde(rename = "en")]
    En,
    #[serde(rename = "pt-BR")]
    PtBr,
}

impl Locale {
    pub fn tag(self) -> &'static str {
        match self {
            Self::En => "en",
            Self::PtBr => "pt-BR",
        }
    }
}

pub fn normalize(tag: &str) -> Option<Locale> {
    let tag = tag.trim().replace('_', "-");
    match tag.split('-').next()?.to_lowercase().as_str() {
        "pt" => Some(Locale::PtBr),
        "en" => Some(Locale::En),
        _ => None,
    }
}

pub fn resolve(choice: Option<&str>, account: Option<&str>, system: Option<&str>) -> Locale {
    [choice, account, system]
        .into_iter()
        .flatten()
        .find_map(normalize)
        .unwrap_or(Locale::En)
}

/// Environment fallback until the window reports the OS language.
pub fn env_locale() -> Option<String> {
    #[cfg(unix)]
    {
        ["LC_ALL", "LC_MESSAGES", "LANG"]
            .into_iter()
            .filter_map(|key| std::env::var(key).ok())
            .find(|tag| normalize(tag).is_some())
    }
    #[cfg(not(unix))]
    {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_supported_language_subtags() {
        for tag in ["pt", "pt-BR", "pt-PT", " pt_BR.UTF-8 ", "PT_br"] {
            assert_eq!(normalize(tag), Some(Locale::PtBr), "{tag}");
        }
        for tag in ["en", "en-US", " EN_gb "] {
            assert_eq!(normalize(tag), Some(Locale::En), "{tag}");
        }
        for tag in ["", "  ", "fr-FR", "C", "POSIX", "C.UTF-8"] {
            assert_eq!(normalize(tag), None, "{tag}");
        }
    }

    #[test]
    fn resolves_in_preference_order() {
        assert_eq!(resolve(Some("en"), Some("pt"), Some("pt")), Locale::En);
        assert_eq!(resolve(None, Some("pt"), Some("en")), Locale::PtBr);
        assert_eq!(resolve(Some("fr"), Some("de"), Some("pt_BR")), Locale::PtBr);
        assert_eq!(resolve(Some("fr"), Some("pt"), Some("en")), Locale::PtBr);
        assert_eq!(resolve(None, None, Some("pt")), Locale::PtBr);
        assert_eq!(resolve(None, None, None), Locale::En);
        assert_eq!(resolve(Some("fr"), None, Some("POSIX")), Locale::En);
    }

    #[test]
    fn serializes_canonical_tags() {
        for locale in [Locale::En, Locale::PtBr] {
            assert_eq!(serde_json::to_value(locale).unwrap(), locale.tag());
        }
    }
}
