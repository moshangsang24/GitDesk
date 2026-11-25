use crate::model::{Failure, Result};
use serde::{Deserialize, Serialize};
use tauri::Url;

#[derive(Clone, Debug, Default, Deserialize, PartialEq, Eq, Serialize)]
#[serde(tag = "mode", rename_all = "camelCase", deny_unknown_fields)]
pub enum RepositoryProxy {
    #[default]
    Git,
    Direct,
    Custom {
        url: String,
    },
}

impl RepositoryProxy {
    pub fn normalize(self) -> Result<Self> {
        let Self::Custom { url } = self else {
            return Ok(self);
        };
        let url = url.trim();
        let invalid = || {
            Failure::invalid(
                "Enter an HTTP, HTTPS, SOCKS5 or SOCKS5H proxy URL without credentials.",
            )
        };
        if url.len() > 512
            || url.contains(['@', '\\'])
            || url
                .bytes()
                .any(|byte| byte.is_ascii_whitespace() || byte.is_ascii_control())
        {
            return Err(invalid());
        }
        let parsed = Url::parse(url).map_err(|_| invalid())?;
        if !matches!(parsed.scheme(), "http" | "https" | "socks5" | "socks5h")
            || parsed.host().is_none()
            || !url.contains("://")
            || parsed.query().is_some()
            || parsed.fragment().is_some()
            || !matches!(parsed.path(), "" | "/")
            || parsed.port() == Some(0)
        {
            return Err(invalid());
        }
        Ok(Self::Custom { url: url.into() })
    }

    pub fn endpoint(&self) -> Option<&str> {
        match self {
            Self::Git => None,
            Self::Direct => Some(""),
            Self::Custom { url } => Some(url),
        }
    }

    pub fn mode(&self) -> &'static str {
        match self {
            Self::Git => "git",
            Self::Direct => "direct",
            Self::Custom { .. } => "custom",
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn accepts_only_supported_proxy_endpoints_without_credentials() {
        let custom = |url: &str| RepositoryProxy::Custom { url: url.into() }.normalize();
        assert!(custom("socks5h://[::1]:1080").is_ok());
        assert!(custom(" http://127.0.0.1:7890 ").is_ok());
        for invalid in [
            "https://user:password@host:443",
            "http://host/path",
            "https://host/?token",
            "file:///tmp/proxy",
            "host:80",
            "http:host",
            "http://host:0",
        ] {
            assert!(custom(invalid).is_err(), "{invalid}");
        }
    }
}
