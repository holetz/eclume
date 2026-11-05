//! Background loops that survive panics: each pass runs in `catch_unwind`. The `lib.rs` hook
//! already logs the panic with a backtrace; here the loop only waits (1 s doubling up to 60 s,
//! reset on success) and continues to the next pass, keeping the state accumulated between passes.
//! Contract: docs/standards/code/desktop-gravacao.md §App and tray.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Duration;

const FIRST_WAIT: Duration = Duration::from_secs(1);
const MAX_WAIT: Duration = Duration::from_secs(60);

/// The wait after a panic, increasing while passes keep panicking.
#[derive(Debug)]
pub struct Backoff {
    first: Duration,
    next: Duration,
}

impl Default for Backoff {
    fn default() -> Self {
        Self::starting_at(FIRST_WAIT)
    }
}

impl Backoff {
    fn starting_at(first: Duration) -> Self {
        Self { first, next: first }
    }

    fn failed(&mut self) -> Duration {
        let wait = self.next;
        self.next = (self.next * 2).min(MAX_WAIT);
        wait
    }

    fn succeeded(&mut self) {
        self.next = self.first;
    }
}

/// Runs one pass of loop `name`. On panic, waits for `backoff` and returns `None`; on success,
/// resets the wait and returns the result.
pub fn pass<T>(backoff: &mut Backoff, name: &str, body: impl FnOnce() -> T) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => {
            backoff.succeeded();
            Some(value)
        }
        Err(_) => {
            let wait = backoff.failed();
            log::error!("panic in a pass of {name}; next pass in {wait:?}");
            std::thread::sleep(wait);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervise_continues_after_panic_with_increasing_wait() {
        let mut backoff = Backoff::starting_at(Duration::from_millis(1));
        assert_eq!(
            pass(&mut backoff, "test", || panic!("broken pass")),
            None::<()>
        );
        assert_eq!(backoff.next, Duration::from_millis(2));
        assert_eq!(pass(&mut backoff, "test", || panic!("again")), None::<()>);
        assert_eq!(backoff.next, Duration::from_millis(4));
        assert_eq!(pass(&mut backoff, "test", || 7), Some(7));
        assert_eq!(backoff.next, Duration::from_millis(1));
    }

    #[test]
    fn supervise_caps_wait_at_one_minute() {
        let mut backoff = Backoff::default();
        for _ in 0..10 {
            backoff.failed();
        }
        assert_eq!(backoff.next, MAX_WAIT);
    }
}
