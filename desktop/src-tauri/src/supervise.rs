//! Laços de fundo que não morrem por pânico: cada passada roda em `catch_unwind`. O pânico já sai
//! no log com o backtrace pelo hook de `lib.rs`; aqui o laço só espera (1 s dobrando até 60 s,
//! zerada no sucesso) e segue na passada seguinte, dono do estado que acumulou entre passadas.
//! Contrato: docs/standards/code/desktop-gravacao.md §App e bandeja.

use std::panic::{catch_unwind, AssertUnwindSafe};
use std::time::Duration;

const FIRST_WAIT: Duration = Duration::from_secs(1);
const MAX_WAIT: Duration = Duration::from_secs(60);

/// A espera depois de um pânico, que cresce enquanto as passadas seguem em pânico.
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

/// Roda uma passada do laço `name`. Em pânico, espera o `backoff` e devolve `None`; no sucesso,
/// zera a espera e devolve o resultado.
pub fn pass<T>(backoff: &mut Backoff, name: &str, body: impl FnOnce() -> T) -> Option<T> {
    match catch_unwind(AssertUnwindSafe(body)) {
        Ok(value) => {
            backoff.succeeded();
            Some(value)
        }
        Err(_) => {
            let wait = backoff.failed();
            log::error!("pânico numa passada de {name}; a próxima vem em {wait:?}");
            std::thread::sleep(wait);
            None
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn supervise_segue_depois_do_panico_com_espera_crescente() {
        let mut backoff = Backoff::starting_at(Duration::from_millis(1));
        assert_eq!(
            pass(&mut backoff, "teste", || panic!("passada quebrada")),
            None::<()>
        );
        assert_eq!(backoff.next, Duration::from_millis(2));
        assert_eq!(
            pass(&mut backoff, "teste", || panic!("de novo")),
            None::<()>
        );
        assert_eq!(backoff.next, Duration::from_millis(4));
        assert_eq!(pass(&mut backoff, "teste", || 7), Some(7));
        assert_eq!(backoff.next, Duration::from_millis(1));
    }

    #[test]
    fn supervise_limita_a_espera_a_um_minuto() {
        let mut backoff = Backoff::default();
        for _ in 0..10 {
            backoff.failed();
        }
        assert_eq!(backoff.next, MAX_WAIT);
    }
}
