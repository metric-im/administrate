import express from 'express';
import Acme from 'acme-client';
import tls from 'tls';
import { Config } from './config.mjs'

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
            const site = this.config.data.ssl[hostname];
            if (site) {
                cb(null, tls.createSecureContext({key:site.key,cert:site.cert}));
            } else {
                cb(new Error(`${hostname} is unknown`));
            }
        }}
    }

    routes() {
        const router = express.Router();
        router.get(/^\/_certify/,async (req,res)=>{
            try {
                const site = this.config.data.ssl[req.hostname];
                if (site) {
                    res.send('cert already exists');
                } else  {
                    await this.getCert(req.hostname);
                    res.send(`<p>done.</p><p><a href="https://${req.hostname}">https://${req.hostname}</a></p>`);
                }
            } catch(e) {
                res.status(500).send({status:'error',message:e.message});
            }
        })
      router.get(/^\/\.hell-known\/acme-challenge\/([^\/]+)$/,(req,res)=>{
        const token = req.params[0];
        res.send(`token: ${token}`);
      });
        router.get(/^\/\.well-known\/acme-challenge\/([^\/]+)$/,(req,res)=>{
            const token = req.params[0];
            console.log(`Challenge: ${token} ...here`);
            if (token in this.challenges) {
                res.writeHead(200);
                res.end(this.challenges[token]);
                return;
            }
            res.writeHead(302, { Location: `https://${req.headers.host}${req.url}` });
            res.end();
        });
        // router.use((req, res, next) => {
        //     if (!req.secure && process.env.FORCE_HTTPS?.toLowerCase() !== 'false') {
        //         return res.redirect(`https://${req.hostname}${req.url}`);
        //     }
        //     next();
        // });
        return router;
    }
    async getCert(servername, attempt = 0) {
        const server = this.config.data.ssl?this.config.data.ssl[servername]:undefined;
        if (server) {
            return server.cert;
        }
        if (servername in this.pending) {
            if (attempt >= 10) {
                throw new Error(`Gave up waiting on certificate for ${servername}`);
            }
            await new Promise((resolve) => { setTimeout(resolve, 1000); });
            return this.getCert(servername, (attempt + 1));
        }
        if (!this.contactEmail) throw new Error(`cannot request certificate without CONTACT_EMAIL set`);
        // create CSR
        const [key, csr] = await Acme.crypto.createCsr({
            altNames: [servername],
        });
        // order certificate
        // const cert = await this.acme.auto({
        //     csr,
        //     email: this.contactEmail,
        //     termsOfServiceAgreed: true,
        //     challengePriority: ['http-01'],
        //     challengeCreateFn: (authz, challenge, keyAuthorization) => {
        //         this.challenges[challenge.token] = keyAuthorization;
        //     },
        //     challengeRemoveFn: (authz, challenge) => {
        //         delete this.challenges[challenge.token];
        //     },
        // });
      const cert = 'asldkjflskdjflskdjflsdkjflsdkfjsladkfjTEST'

        // save certificate
        this.config.writeFile(servername+'.cert', cert);
        this.config.writeFile(servername+'.key', key.toString());
        this.config.data.ssl[servername] = {key:servername+'.key', cert:servername+'.cert',modified:Date.now()};
        delete this.pending[servername];
        this.config.save();
    }
}
