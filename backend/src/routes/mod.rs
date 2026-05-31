pub mod auth;
pub mod calendar;
pub mod day;
pub mod history;
pub mod projects;
pub mod schedules;
pub mod tasks;

pub use auth::router as auth_routes;
pub use calendar::router as calendar_routes;
pub use day::router as day_routes;
pub use history::router as history_routes;
pub use projects::router as projects_routes;
pub use schedules::router as schedules_routes;
pub use tasks::router as tasks_routes;
