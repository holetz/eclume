// Vendorizado de fastrepl/anarlog@bfb8d9e4ff7fcc8c9aeab2f52cc020d16b195e43:crates/resampler/src/lib.rs,
// sem a feature `async-source` (que depende de crates internos do workspace do Anarlog).
// Licença MIT; ver LICENSE e VENDOR.md neste crate.

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

    // Teste do eclume (não vem do Anarlog): 48 kHz → 16 kHz preserva a duração.
    #[test]
    fn reamostra_48k_para_16k_com_a_duracao_certa() {
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
        assert!(diff <= 480, "saída com {} amostras", out.len());
        let peak = out.iter().fold(0.0f32, |m, s| m.max(s.abs()));
        assert!(peak > 0.4 && peak < 0.6, "pico {peak}");
    }
}
