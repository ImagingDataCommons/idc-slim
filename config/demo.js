window.config = {
  path: '/slim',
  servers: [
    {
      id: 'demo',
      url: window.slim.env.SLIM_DEMO_DICOMWEB_URL,
      write: false
    }
  ],
  preload: true,
  disableAnnotationTools: false,
  // Direct in-browser download, streamed from public AWS S3 into a folder the
  // user picks. Off by default and deliberately so: it is only useful when the
  // configured DICOMweb server is backed by an archive the resolver can look
  // identifiers up in, and a button that resolves nothing is worse than no
  // button. Enable it on IDC-backed deployments.
  //
  // download: {
  //   enabled: true,
  //   provider: 'idc',
  //   // Optional. Defaults shown.
  //   // layout: 'nested',           // matches the `idc download` CLI tree
  //   // concurrency: 6,             // the HTTP/1.1 per-origin limit
  //   // limits: { warnBytes: 5368709120, refuseBytes: 214748364800 }
  // },
  annotations: [
    {
      finding: { value: '85756007', schemeDesignator: 'SCT', meaning: 'Tissue' }
    }
  ],
  // Logger configuration
  logger: {
    level: 'WARN', // DEBUG, LOG, WARN, ERROR, NONE
    enableInProduction: false,
    enableInDevelopment: true
  }
}
