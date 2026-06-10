use serde::{Deserialize, Serialize};
use ts_rs::TS;
use uuid::Uuid;

macro_rules! id_types {
    ($($name:ident),+ $(,)?) => {$(
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
        #[ts(export)]
        pub struct $name(pub Uuid);

        impl $name {
            pub fn new() -> Self {
                Self(Uuid::now_v7())
            }
        }

        impl Default for $name {
            fn default() -> Self {
                Self::new()
            }
        }
    )+};
}

id_types!(UserId, ProjectId, TaskId, ScheduleId, ScheduleItemId);

/// Lexicographic fractional-indexing key; backs `tasks.list_order` and `schedule_items.position`.
#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize, TS)]
#[ts(export)]
pub struct OrderKey(pub String);

/// Per-user monotonic logical counter; the LWW key, bumped on every write (incl. delete).
pub type Revision = i64;

/// Epoch-ms wall time, for display/ranking.
pub type Millis = i64;

/// Embedded as `rev` on every syncable row; `deleted` set ⇒ tombstone.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "camelCase")]
#[ts(export)]
pub struct Revisions {
    pub updated: Revision,
    pub deleted: Option<Revision>,
}

/// Palette keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, TS)]
#[serde(rename_all = "lowercase")]
#[ts(export)]
pub enum Color {
    Violet,
    Blue,
    Sky,
    Seafoam,
    Lime,
    Yellow,
    Orange,
    Magenta,
}

impl Color {
    pub fn as_key(self) -> &'static str {
        match self {
            Color::Violet => "violet",
            Color::Blue => "blue",
            Color::Sky => "sky",
            Color::Seafoam => "seafoam",
            Color::Lime => "lime",
            Color::Yellow => "yellow",
            Color::Orange => "orange",
            Color::Magenta => "magenta",
        }
    }

    pub fn from_key(s: &str) -> Option<Self> {
        Some(match s {
            "violet" => Color::Violet,
            "blue" => Color::Blue,
            "sky" => Color::Sky,
            "seafoam" => Color::Seafoam,
            "lime" => Color::Lime,
            "yellow" => Color::Yellow,
            "orange" => Color::Orange,
            "magenta" => Color::Magenta,
            _ => return None,
        })
    }
}
