
window.config = {
  path: "/slim",
  publicLibPath: "/slim/static/js/",
  /** This is an array, but we'll only use the first entry for now */
  servers: [
    {
      id: "idc",
      url: 'https://dev-proxy.canceridc.dev/current/viewer-only-no-downloads-see-tinyurl-dot-com-slash-3j3d9jyp/dicomWeb',
      write: false
    }
  ],
  annotations: [ ],
  disableWorklist: true,
  disableAnnotationTools: true
};
