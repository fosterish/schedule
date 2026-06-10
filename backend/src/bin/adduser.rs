use std::io::Write;

use schedule::auth::hash_password;
use schedule::{db, load_env};

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    load_env();

    let args = std::env::args().skip(1);
    let mut reset = false;
    let mut username: Option<String> = None;
    for a in args {
        if a == "--reset" {
            reset = true;
        } else if username.is_none() {
            username = Some(a);
        } else {
            anyhow::bail!("usage: adduser [--reset] <username>");
        }
    }
    let username =
        username.ok_or_else(|| anyhow::anyhow!("usage: adduser [--reset] <username>"))?;

    let database_url = std::env::var("DATABASE_URL")
        .unwrap_or_else(|_| "sqlite://schedule.db?mode=rwc".to_string());
    let pool = db::connect(&database_url).await?;
    db::migrate(&pool).await?;

    let existing: Option<(String,)> = sqlx::query_as("SELECT id FROM users WHERE username = ?")
        .bind(&username)
        .fetch_optional(&pool)
        .await?;

    if existing.is_some() && !reset {
        anyhow::bail!("user '{}' already exists; pass --reset to update", username);
    }
    if existing.is_none() && reset {
        anyhow::bail!("user '{}' does not exist; drop --reset to create", username);
    }

    let pw = prompt_password()?;

    let hash = hash_password(&pw)?;
    if existing.is_some() {
        sqlx::query("UPDATE users SET password_hash = ? WHERE username = ?")
            .bind(&hash)
            .bind(&username)
            .execute(&pool)
            .await?;
        println!("password updated for '{}'.", username);
    } else {
        let id = uuid::Uuid::now_v7().to_string();
        sqlx::query("INSERT INTO users (id, username, password_hash) VALUES (?, ?, ?)")
            .bind(&id)
            .bind(&username)
            .bind(&hash)
            .execute(&pool)
            .await?;
        println!("user '{}' created.", username);
    }

    Ok(())
}

fn prompt_password() -> anyhow::Result<String> {
    let read_pw = |prompt: &str| -> anyhow::Result<String> {
        print!("{}", prompt);
        std::io::stdout().flush()?;
        // rpassword needs a TTY; fall back to a plain line read for CI/piped stdin.
        match rpassword::read_password() {
            Ok(s) => Ok(s),
            Err(_) => {
                let mut s = String::new();
                std::io::stdin().read_line(&mut s)?;
                Ok(s.trim_end_matches(['\n', '\r']).to_string())
            }
        }
    };
    let pw1 = read_pw("password: ")?;
    let pw2 = read_pw("confirm:  ")?;
    if pw1 != pw2 {
        anyhow::bail!("passwords don't match");
    }
    if pw1.is_empty() {
        anyhow::bail!("password is empty");
    }
    Ok(pw1)
}
