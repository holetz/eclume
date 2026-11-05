//! Supported UI locales and account/device precedence.

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Locale {
    #[default]
    En,
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

/// Maps the base language of a tag using the server's normalization rules.
pub fn normalize(tag: &str) -> Option<Locale> {
    match tag.trim().split(['-', '_']).next()?.to_lowercase().as_str() {
        "en" => Some(Locale::En),
        "pt" => Some(Locale::PtBr),
        _ => None,
    }
}

pub fn resolve(account: Option<&str>, device: Option<&str>) -> Locale {
    account
        .and_then(normalize)
        .or_else(|| device.and_then(normalize))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn normalizes_base_languages_like_the_server() {
        for tag in ["pt", "pt-br", "pt_BR", "pt-PT", " PT-br "] {
            assert_eq!(normalize(tag), Some(Locale::PtBr), "{tag}");
        }
        for tag in ["en", "en-US", "en-GB", "EN_us", " en "] {
            assert_eq!(normalize(tag), Some(Locale::En), "{tag}");
        }
        for tag in ["", " ", "es", "fr-FR", "-en", "english"] {
            assert_eq!(normalize(tag), None, "{tag}");
        }
    }

    #[test]
    fn resolves_account_then_device_then_english() {
        assert_eq!(resolve(Some("en-US"), Some("pt_BR")), Locale::En);
        assert_eq!(resolve(Some("pt-PT"), Some("en")), Locale::PtBr);
        assert_eq!(resolve(None, Some("pt_BR")), Locale::PtBr);
        assert_eq!(resolve(Some("es"), Some("pt")), Locale::PtBr);
        assert_eq!(resolve(Some(""), Some("en-GB")), Locale::En);
        assert_eq!(resolve(None, None), Locale::En);
        assert_eq!(resolve(Some("fr"), Some("es")), Locale::En);
        assert_eq!(Locale::default().tag(), "en");
        assert_eq!(Locale::PtBr.tag(), "pt-BR");
    }
}
