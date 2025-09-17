import express from 'express';
import Acme from 'acme-client';
import tls from 'tls';
import { Config } from './config.mjs';
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
        if (!instance.config.data.ssl) instance.config.data.ssl = {};
        instance.contactEmail = instance.config.profile?.email || instance.options.contactEmail;
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
      const site = this.config.data.ssl ? this.config.data.ssl[sitename] : undefined;
      if (!site?.certified || moment().isAfter(moment(site.certified).add(MAX_AGE, 'days'))) {
        if (!this.pending[sitename] || moment().isAfter(moment(this.pending[sitename]).add(MAX_WAIT_TIME, 'seconds'))) {
          try {
            this.pending[sitename] = moment();
            setTimeout(async () => {
              await this.renewCert(sitename);
            },10);
          } catch(e) {
            console.error(e);
          }
        }
      }
      if (site) {
        const key = this.config.readFile(site.key).toString();
        const cert = this.config.readFile(site.cert).toString();
        return {key: key, cert: cert};
      } else {
        return null;
      }
    }
    async renewCert(sitename) {
      const site = this.config.data.ssl ? this.config.data.ssl[sitename] : undefined;
      if (site?.certified && moment().isBefore(moment(site.certified).add(MAX_AGE, 'days'))) {
        return;
      } else {
        if (!this.contactEmail) throw new Error(`cannot request certificate without CONTACT_EMAIL set`);
        this.pending[sitename] = true;
        // create CSR
        const [key, csr] = await Acme.crypto.createCsr({
          altNames: [sitename],
        });
        // order certificate
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
        // save certificate
        this.config.writeFile(sitename+'.cert', cert);
        this.config.writeFile(sitename+'.key', key.toString());
        this.config.data.ssl[sitename] = {key:sitename+'.key', cert:sitename+'.cert',certified:moment().format("YYYY-MM-DD")};
        delete this.pending[sitename];
        this.config.save();
      }
    }
}
