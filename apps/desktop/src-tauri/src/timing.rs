use std::sync::Arc;
use std::time::{Duration, Instant};

use rustls::client::danger::{HandshakeSignatureValid, ServerCertVerified, ServerCertVerifier};
use rustls::pki_types::{CertificateDer, ServerName, UnixTime};
use rustls::{ClientConfig, DigitallySignedStruct, SignatureScheme};
use tokio::net::TcpStream;
use tokio_rustls::TlsConnector;

const PHASE_TIMEOUT: Duration = Duration::from_secs(5);

#[derive(Debug, Clone, Copy)]
pub struct PhaseTimings {
    pub dns_ms: u64,
    pub tcp_ms: u64,
    pub tls_ms: Option<u64>,
}

/// 通过一条独立的探测连接测量 DNS、TCP 与 TLS 阶段耗时。
/// 代理或客户端证书场景下不探测，避免绕过实际请求的网络路径。
pub async fn probe(url: &reqwest::Url, accept_invalid_certs: bool) -> Option<PhaseTimings> {
    let host = url.host_str()?.to_string();
    let port = url.port_or_known_default()?;

    let dns_started = Instant::now();
    let addrs = tokio::time::timeout(
        PHASE_TIMEOUT,
        tokio::net::lookup_host((host.as_str(), port)),
    )
    .await
    .ok()?
    .ok()?;
    let addr = addrs.into_iter().next()?;
    let dns_ms = dns_started.elapsed().as_millis() as u64;

    let tcp_started = Instant::now();
    let tcp = tokio::time::timeout(PHASE_TIMEOUT, TcpStream::connect(addr))
        .await
        .ok()?
        .ok()?;
    let tcp_ms = tcp_started.elapsed().as_millis() as u64;

    let tls_ms = if url.scheme() == "https" {
        let tls_started = Instant::now();
        let config = tls_config(accept_invalid_certs)?;
        let connector = TlsConnector::from(config);
        let server_name = ServerName::try_from(host).ok()?;
        let stream = tokio::time::timeout(PHASE_TIMEOUT, connector.connect(server_name, tcp))
            .await
            .ok()?
            .ok()?;
        drop(stream);
        Some(tls_started.elapsed().as_millis() as u64)
    } else {
        None
    };

    Some(PhaseTimings {
        dns_ms,
        tcp_ms,
        tls_ms,
    })
}

fn tls_config(accept_invalid_certs: bool) -> Option<Arc<ClientConfig>> {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let builder = ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions()
        .ok()?;

    if accept_invalid_certs {
        return Some(Arc::new(
            builder
                .dangerous()
                .with_custom_certificate_verifier(Arc::new(NoVerifier { provider }))
                .with_no_client_auth(),
        ));
    }

    let mut roots = rustls::RootCertStore::empty();
    for cert in rustls_native_certs::load_native_certs().certs {
        roots.add(cert).ok();
    }
    Some(Arc::new(
        builder.with_root_certificates(roots).with_no_client_auth(),
    ))
}

#[derive(Debug)]
struct NoVerifier {
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl ServerCertVerifier for NoVerifier {
    fn verify_server_cert(
        &self,
        _end_entity: &CertificateDer<'_>,
        _intermediates: &[CertificateDer<'_>],
        _server_name: &ServerName<'_>,
        _ocsp_response: &[u8],
        _now: UnixTime,
    ) -> Result<ServerCertVerified, rustls::Error> {
        Ok(ServerCertVerified::assertion())
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        cert: &CertificateDer<'_>,
        dss: &DigitallySignedStruct,
    ) -> Result<HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            cert,
            dss,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}
