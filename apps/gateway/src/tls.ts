import selfsigned from 'selfsigned';
import { readSystemDomainZone } from '@launchos/domain';

export type GatewayTls = {
  cert: string;
  key: string;
};

export function createGatewayCertificate(): GatewayTls {
  const zone = readSystemDomainZone();
  const pems = selfsigned.generate(
    [{ name: 'commonName', value: `*.${zone}` }],
    {
      keySize: 2048,
      days: 825,
      algorithm: 'sha256',
      extensions: [
        {
          name: 'basicConstraints',
          cA: false,
        },
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: `*.${zone}` },
            { type: 2, value: zone },
            { type: 2, value: '*.localhost' },
            { type: 2, value: 'localhost' },
          ],
        },
      ],
    },
  );

  return {
    cert: pems.cert,
    key: pems.private,
  };
}
