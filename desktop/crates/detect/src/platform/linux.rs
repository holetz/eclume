// fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:crates/detect/src/list/linux.rs
//! Mic users on Linux: Pulse source-outputs (or PipeWire through the Pulse layer) that
//! are active and do not read an output monitor — reading a monitor captures system audio,
//! rather than using the mic.

use std::cell::RefCell;
use std::collections::HashSet;
use std::rc::Rc;
use std::time::{Duration, Instant};

use anyhow::{anyhow, bail, Result};
use libpulse_binding::callbacks::ListResult;
use libpulse_binding::context::{Context, FlagSet, State};
use libpulse_binding::mainloop::standard::{IterateResult, Mainloop};

use crate::classify::{AudioClient, Snapshot};

const TIMEOUT: Duration = Duration::from_secs(2);
const IDLE_WAIT: Duration = Duration::from_millis(10);

/// An active source-output and the source it reads.
struct Output {
    client: AudioClient,
    source: u32,
}

#[derive(Default)]
struct Query {
    monitors: HashSet<u32>,
    outputs: Vec<Output>,
    done: bool,
    failed: bool,
}

pub(super) fn snapshot() -> Result<Snapshot> {
    let mut mainloop = Mainloop::new().ok_or_else(|| anyhow!("sem mainloop do Pulse"))?;
    let mut context =
        Context::new(&mainloop, "eclume-detect").ok_or_else(|| anyhow!("sem contexto do Pulse"))?;
    context
        .connect(None, FlagSet::NOFLAGS, None)
        .map_err(|err| anyhow!("falha ao conectar ao Pulse: {err}"))?;
    let result = query(&mut mainloop, &context);
    context.disconnect();
    let outputs = result?;
    Ok(Snapshot {
        mic_users: outputs.into_iter().map(|o| o.client).collect(),
        ..Snapshot::default()
    })
}

fn query(mainloop: &mut Mainloop, context: &Context) -> Result<Vec<Output>> {
    let deadline = Instant::now() + TIMEOUT;
    loop {
        match context.get_state() {
            State::Ready => break,
            State::Failed | State::Terminated => bail!("o Pulse recusou a conexão"),
            _ => iterate(mainloop, deadline)?,
        }
    }

    let introspect = context.introspect();
    let sources = Rc::new(RefCell::new(Query::default()));
    let on_source = Rc::clone(&sources);
    let _sources_op = introspect.get_source_info_list(move |result| {
        let mut query = on_source.borrow_mut();
        match result {
            ListResult::Item(info) => {
                if info.monitor_of_sink.is_some() {
                    query.monitors.insert(info.index);
                }
            }
            ListResult::End => query.done = true,
            ListResult::Error => {
                query.failed = true;
                query.done = true;
            }
        }
    });
    wait(mainloop, &sources, deadline)?;

    let outputs = Rc::new(RefCell::new(Query::default()));
    let on_output = Rc::clone(&outputs);
    let _outputs_op = introspect.get_source_output_info_list(move |result| {
        let mut query = on_output.borrow_mut();
        match result {
            ListResult::Item(info) => {
                if info.corked {
                    return;
                }
                let props = &info.proplist;
                let name = props
                    .get_str("application.name")
                    .or_else(|| props.get_str("application.process.binary"))
                    .unwrap_or_default();
                let id = props
                    .get_str("application.process.binary")
                    .unwrap_or_else(|| name.clone());
                if id.is_empty() {
                    return;
                }
                let mut client = AudioClient::new(id, name);
                client.pid = props
                    .get_str("application.process.id")
                    .and_then(|pid| pid.parse().ok());
                query.outputs.push(Output {
                    client,
                    source: info.source,
                });
            }
            ListResult::End => query.done = true,
            ListResult::Error => {
                query.failed = true;
                query.done = true;
            }
        }
    });
    wait(mainloop, &outputs, deadline)?;

    let monitors = std::mem::take(&mut sources.borrow_mut().monitors);
    let outputs = std::mem::take(&mut outputs.borrow_mut().outputs);
    Ok(outputs
        .into_iter()
        .filter(|output| !monitors.contains(&output.source))
        .collect())
}

fn wait(mainloop: &mut Mainloop, query: &Rc<RefCell<Query>>, deadline: Instant) -> Result<()> {
    loop {
        {
            let query = query.borrow();
            if query.done {
                if query.failed {
                    bail!("a consulta ao Pulse falhou");
                }
                return Ok(());
            }
        }
        iterate(mainloop, deadline)?;
    }
}

fn iterate(mainloop: &mut Mainloop, deadline: Instant) -> Result<()> {
    if Instant::now() >= deadline {
        bail!("o Pulse não respondeu em {} s", TIMEOUT.as_secs());
    }
    match mainloop.iterate(false) {
        IterateResult::Success(0) => std::thread::sleep(IDLE_WAIT),
        IterateResult::Success(_) => {}
        IterateResult::Quit(_) => bail!("o mainloop do Pulse encerrou"),
        IterateResult::Err(err) => bail!("erro no mainloop do Pulse: {err}"),
    }
    Ok(())
}
