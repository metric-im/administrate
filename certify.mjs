import express from 'express';
import Acme from 'acme-client';
import tls from 'tls';
import { Config } from './config.mjs';
import moment from 'moment';

const MAX_AGE = 75; // days

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
        // router.use('/',async(req, res, next) => {
        //   try {
        //     const site = this.config.data.ssl[req.hostname];
        //     if (!site) return next();
        //     if (!site.certified || moment().isAfter(moment(site.certified).add(MAX_AGE,'days'))) {
        //       console.log(`New certificate required for ${req.hostname}`);
        //       await this.getCert(req.hostname);
        //       return res.redirect(req.url)
        //     }
        //   } catch(e) {
        //     console.error(e);
        //   }
        //   next();
        // });
        // router.get(/^\/_certify/,async (req,res)=>{
        //     try {
        //         const site = this.config.data.ssl[req.hostname];
        //         if (site) {
        //             res.send('cert already exists');
        //         } else  {
        //             await this.getCert(req.hostname);
        //             res.send(`<p>done.</p><p><a href="https://${req.hostname}">https://${req.hostname}</a></p>`);
        //         }
        //     } catch(e) {
        //         res.status(500).send({status:'error',message:e.message});
        //     }
        // })
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
      if (!site || moment().isAfter(moment(site.certified).add(MAX_AGE, 'days'))) {
        setImmediate(async () => {
          await this.renewCert(sitename);
        });
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
      if (site && moment().isBefore(moment(site.certified).add(MAX_AGE, 'days'))) {
        return;
      } else if (this.pending[sitename]) {
        if (attempt >= 10) {
          delete this.pending[sitename];
          console.error(`Gave up waiting on certificate for ${sitename}`);
          return;
        }
        await new Promise((resolve) => { setTimeout(resolve, 1000); });
        return await this.renewCert(sitename, (attempt + 1));
      } else {
        if (!this.contactEmail) throw new Error(`cannot request certificate without CONTACT_EMAIL set`);
        // create CSR
        const [key, csr] = await Acme.crypto.createCsr({
          altNames: [sitename],
        });
        // order certificate
        this.pending[sitename] = true;
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
