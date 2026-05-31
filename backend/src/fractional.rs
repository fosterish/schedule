//! Fractional ordering helpers for `tasks.list_order` and `schedule_items.position`.

use crate::error::{AppError, AppResult};

/// Minimum gap below which we trigger a full rebalance.
const MIN_GAP: f64 = 1e-9;

/// Position the moved row after `after_id` (or at head); rebalances when the neighbor gap is below [`MIN_GAP`].
pub fn compute_reorder_position(
    ordered_pairs: &[(i64, f64)],
    moved_id: i64,
    after_id: Option<i64>,
) -> AppResult<ReorderPlan> {
    let mut filtered: Vec<(i64, f64)> = ordered_pairs
        .iter()
        .copied()
        .filter(|(id, _)| *id != moved_id)
        .collect();
    let target_idx_after: Option<usize> = match after_id {
        None => None, // head
        Some(aid) => match filtered.iter().position(|(id, _)| *id == aid) {
            Some(i) => Some(i),
            None => return Err(AppError::bad_request("after_task_id not in scope")),
        },
    };

    let (left, right) = match target_idx_after {
        None => (None, filtered.first().copied()),
        Some(i) => {
            let left = filtered[i];
            let right = filtered.get(i + 1).copied();
            (Some(left), right)
        }
    };

    let new_pos = match (left, right) {
        (None, None) => 1.0,
        (None, Some((_, r))) => r / 2.0,
        (Some((_, l)), None) => l + 1.0,
        (Some((_, l)), Some((_, r))) => (l + r) / 2.0,
    };

    let needs_rebalance = match (left, right) {
        (Some((_, l)), Some((_, r))) => (r - l).abs() < MIN_GAP,
        (None, Some((_, r))) => r.abs() < MIN_GAP,
        _ => false,
    };

    if needs_rebalance {
        let mut output = Vec::with_capacity(filtered.len() + 1);
        let after = target_idx_after; // 0-indexed in filtered
        let mut pos_counter = 0.0;
        for (idx, (id, _)) in filtered.drain(..).enumerate() {
            pos_counter += 1.0;
            output.push((id, pos_counter));
            if Some(idx) == after {
                pos_counter += 1.0;
                output.push((moved_id, pos_counter));
            }
        }
        if after.is_none() {
            for p in output.iter_mut() {
                p.1 += 1.0;
            }
            output.insert(0, (moved_id, 1.0));
        } else if after
            == Some(
                output
                    .iter()
                    .filter(|(id, _)| *id != moved_id)
                    .count()
                    .saturating_sub(1),
            )
        {
            // Tail insert is already handled by the loop above.
        }
        let new_pos = output
            .iter()
            .find(|(id, _)| *id == moved_id)
            .map(|(_, p)| *p)
            .unwrap_or(1.0);
        return Ok(ReorderPlan {
            new_position: new_pos,
            rebalance: Some(output),
        });
    }

    Ok(ReorderPlan {
        new_position: new_pos,
        rebalance: None,
    })
}

#[derive(Debug)]
pub struct ReorderPlan {
    pub new_position: f64,
    /// If set, caller must update every row in scope to these (id, position) values.
    pub rebalance: Option<Vec<(i64, f64)>>,
}
