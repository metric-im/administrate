import express from 'express';
import Acme from 'acme-client';
import tls from 'tls';
import { Config } from 'epistery';
import moment from 'moment';

const MAX_AGE = 75; // days
const MAX_WAIT_TIME = 60; // seconds

export class Certify {
    constructor(app,options) {
        this.app = app;
        this.options = options || {};
        this.pending = {};
        this.challenges = {};
        this.contactEmail = undefined;
    }
    static async attach(app,options) {
        const instance = new Certify(app,options);
        instance.config = new Config();

        // Load root config to get contact email
        instance.config.setPath('/');
        instance.config.load();

        instance.contactEmail = instance.options.contactEmail || instance.config.data.ssl?.email || instance.config.data.profile?.email;

        instance.acme = new Acme.Client({
            directoryUrl: Acme.directory.letsencrypt[process.env.PROFILE==='DEV'?'staging':'production'],
            accountKey: await Acme.crypto.createPrivateKey(),
        });
        if (process.env.PROFILE==='DEV'){
          Acme.setLogger((message) => {
            console.log(message);
          });
        }
        app.use('/',instance.routes());
        return instance;
    }
    get SNI() {
        return {SNICallback: async (hostname, cb) => {
            try {
              if (this.pending[hostname]) return(cb('pending'));
              console.log(`SNL get keys for ${hostname}`)
              const siteKeys = await this.getSiteKeys(hostname);
              cb(null, tls.createSecureContext(siteKeys));
            } catch (error) {
              console.error(`Error loading certificate for ${hostname}:`, error);
              cb(error);
            }
        }}
    }
    routes() {
        const router = express.Router();

        router.get(/^\/\.well-known\/acme-challenge\/([^\/]+)$/,(req,res)=>{
            const token = req.params[0];
            if (token in this.challenges) {
                res.writeHead(200);
                res.end(this.challenges[token]);
                return;
            }
            // Don't redirect ACME challenges - return 404 instead (says Claude, used to be 302)
            res.writeHead(404);
            res.end('Challenge not found');
        });
        // router.use('/',(req, res, next) => {
        //     if (!req.secure && process.env.FORCE_HTTPS?.toLowerCase() !== 'false') {
        //         return res.redirect(`https://${req.hostname}${req.url}`);
        //     }
        //     next();
        // });
        return router;
    }
    async getSiteKeys(sitename) {
      // For localhost and local domains, don't try to get Let's Encrypt certificates
      if (sitename === 'localhost' || sitename.includes('.local') || sitename.match(/^\d+\.\d+\.\d+\.\d+$/)) {
        return null; // Use default certificate
      }

      // Load domain-specific config to check SSL section
      this.config.setPath(`/${sitename}`);
      this.config.load();
      const sslConfig = this.config.data.ssl;

      if (!sslConfig?.certified || moment().isAfter(moment(sslConfig.certified).add(MAX_AGE, 'days'))) {
        if (!this.pending[sitename] || moment().isAfter(moment(this.pending[sitename]).add(MAX_WAIT_TIME, 'seconds'))) {
          try {
            this.pending[sitename] = moment();
            setTimeout(async () => {
              try {
                await this.renewCert(sitename);
              } catch (e) {
                console.error(`Failed to renew certificate for ${sitename}:`, e);
                delete this.pending[sitename];
              }
            },10);
          } catch(e) {
            console.error(e);
            delete this.pending[sitename];
          }
        }
      }
      if (sslConfig?.key && sslConfig?.cert) {
        const key = this.config.readFile(sslConfig.key).toString();
        const cert = this.config.readFile(sslConfig.cert).toString();
        return {key: key, cert: cert};
      } else {
        return null;
      }
    }
    async renewCert(sitename) {
      // Load domain config to check SSL certification date
      this.config.setPath(`/${sitename}`);
      this.config.load();
      const sslConfig = this.config.data.ssl;

      if (sslConfig?.certified && moment().isBefore(moment(sslConfig.certified).add(MAX_AGE, 'days'))) {
        return;
      } else {
        if (!this.contactEmail) throw new Error(`cannot request certificate without CONTACT_EMAIL set`);
        this.pending[sitename] = moment();

        try {
          // Add timeout wrapper for the entire certificate renewal process
          await Promise.race([
            this.doRenewCert(sitename),
            new Promise((_, reject) =>
              setTimeout(() => reject(new Error(`Certificate renewal timeout for ${sitename}`)), 120000) // 2 minute timeout
            )
          ]);
        } catch (error) {
          console.error(`Certificate renewal failed for ${sitename}:`, error);
          delete this.pending[sitename];
          throw error;
        }
      }
    }

    async doRenewCert(sitename) {
      // Check if domain has an epistery address
      const domainConfig = this.config.read(sitename);
      const episteryAddress = domainConfig?.wallet?.address;

      // Prepare CSR options
      const csrOptions = {
        altNames: [sitename],
      };

      // // letsencrypt will not accept an OU it doesn't certify
      // if (episteryAddress) {
      //   // RFC 5280: Use organization (O) field to identify Rootz Corp as binding provider
      //   csrOptions.organization = 'Rootz Corp';
      //   // RFC 5280: Use organizationUnit (OU) to store epistery identity address
      //   // This binds the domain to the epistery address in the certificate
      //   // Users can verify at /.well-known/epistery/status (RFC 8615 well-known URI)
      //   csrOptions.organizationUnit = `Epistery: ${episteryAddress}`;
      //   console.log(`Binding epistery identity ${episteryAddress} to certificate for ${sitename}`);
      //   console.log(`Epistery binding verifiable at https://${sitename}/.well-known/epistery/status`);
      // }

      // create CSR
      const [key, csr] = await Acme.crypto.createCsr(csrOptions);

      // order certificate with timeout
      const cert = await this.acme.auto({
        csr,
        email: this.contactEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: (authz, challenge, keyAuthorization) => {
          this.challenges[challenge.token] = keyAuthorization;
        },
        challengeRemoveFn: (authz, challenge) => {
          delete this.challenges[challenge.token];
        },
      });

      // Set path to domain directory and save certificate files there
      this.config.setPath(`/${sitename}`);
      this.config.writeFile('ssl_cert.pem', cert);
      this.config.writeFile('ssl_key.pem', key.toString());

      // Load existing config and add/update [ssl] section
      this.config.load();
      if (!this.config.data.ssl) this.config.data.ssl = {};
      this.config.data.ssl.key = 'ssl_key.pem';
      this.config.data.ssl.cert = 'ssl_cert.pem';
      this.config.data.ssl.certified = moment().format("YYYY-MM-DD");

      delete this.pending[sitename];
      this.config.save();

      console.log(`Certificate successfully renewed for ${sitename}`);
    }
}
