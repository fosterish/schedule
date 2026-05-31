use serde::{Deserialize, Serialize, Serializer};
use sqlx::FromRow;
use time::macros::format_description;
use time::Date;

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct WeekdayBinding {
    pub user_id: i64,
    pub weekday: i64,
    pub schedule_id: Option<i64>,
}

#[derive(Debug, Clone, FromRow, Serialize)]
pub struct DateOverride {
    pub user_id: i64,
    #[serde(serialize_with = "serialize_date_iso")]
    pub date: Date,
    pub schedule_id: i64,
}

fn serialize_date_iso<S: Serializer>(date: &Date, s: S) -> Result<S::Ok, S::Error> {
    let fmt = format_description!("[year]-[month]-[day]");
    let str_ = date.format(fmt).map_err(serde::ser::Error::custom)?;
    s.serialize_str(&str_)
}

#[derive(Debug, Deserialize)]
pub struct PutWeekdayBindings {
    pub bindings: Vec<WeekdayBindingInput>,
}

#[derive(Debug, Deserialize)]
pub struct WeekdayBindingInput {
    pub weekday: i64,
    pub schedule_id: Option<i64>,
}

#[derive(Debug, Deserialize)]
pub struct PutDateOverride {
    pub schedule_id: i64,
}
