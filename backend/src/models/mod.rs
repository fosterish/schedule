pub mod project;
pub mod schedule;
pub mod settings;

use uuid::Uuid;

use crate::error::AppError;
use crate::types::common::Color;

/// Parse a TEXT id column into a `Uuid` (rows we wrote are always valid).
pub(crate) fn parse_uuid(s: &str) -> Result<Uuid, AppError> {
    Uuid::parse_str(s).map_err(|e| AppError::Other(anyhow::anyhow!("invalid uuid {s:?}: {e}")))
}

pub(crate) fn parse_color(s: &str) -> Result<Color, AppError> {
    Color::from_key(s).ok_or_else(|| AppError::Other(anyhow::anyhow!("invalid color {s:?}")))
}
