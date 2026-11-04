// Vendored from fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:
// crates/resampler/src/lib.rs,
// without the `async-source` feature (which depends on internal Anarlog workspace crates).
// MIT license; see LICENSE and VENDOR.md in this crate.

mod driver;

pub use driver::RubatoChunkResampler;
pub use rubato::{
    Async, FixedAsync, Indexing, PolynomialDegree, Resampler, SincInterpolationParameters,
    SincInterpolationType, WindowFunction,
};

#[derive(thiserror::Error, Debug)]
pub enum Error {
    #[error(transparent)]
    ResampleError(#[from] rubato::ResampleError),
    #[error(transparent)]
    ResamplerConstructionError(#[from] rubato::ResamplerConstructionError),
}

#[cfg(test)]
mod tests {
    use super::*;

    // eclume test (not from Anarlog): 48 kHz → 16 kHz preserves duration.
    #[test]
    fn resamples_48k_to_16k_with_correct_duration() {
        let block = 480;
        let resampler = Async::<f32>::new_poly(
            16_000.0 / 48_000.0,
            1.0,
            PolynomialDegree::Cubic,
            block,
            1,
            FixedAsync::Input,
        )
        .unwrap();
        let mut driver = RubatoChunkResampler::<_, 1>::new(resampler, 160, block);

        let input: Vec<f32> = (0..48_000)
            .map(|i| (i as f32 * 440.0 * std::f32::consts::TAU / 48_000.0).sin() * 0.5)
            .collect();
        for sample in &input {
            driver.push_sample(*sample);
        }
        driver.process_all_ready_blocks().unwrap();
        driver.process_partial_block(true).unwrap();

        let out = driver.take_all_output().unwrap();
        let diff = (out.len() as i64 - 16_000).abs();
        assert!(diff <= 480, "output with {} samples", out.len());
        let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.4 && peak < 0.6, "peak {peak}");
    }
}
