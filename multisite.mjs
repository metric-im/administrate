import express from 'express';
import tls from 'tls';
import { Config } from './config.mjs';
import moment from 'moment';
import fs from "fs";
import {resolve} from "path";
import child_process from "child_process";
import axios from 'axios';

const MAX_AGE = 75; // days
const MAX_WAIT_TIME = 60; // seconds

export class MultiSite {
    constructor(app,options) {
        this.app = app;
        this.options = options || {};
        this.sites = {};
        this._spawnPort = (parseInt(this.options.spawnPort||0) || 53874);
        this.usedPorts = new Set();
        this.setupCleanup();
    }
    get spawnPort() {
        const port = this._spawnPort++;
        this.usedPorts.add(port);
        return port;
    }

    setupCleanup() {
        process.on('SIGTERM', () => this.cleanup());
        process.on('SIGINT', () => this.cleanup());
        process.on('exit', () => this.cleanup());
    }

    cleanup() {
        console.log('Cleaning up spawned processes...');
        Object.values(this.sites).forEach(site => {
            if (site.proc && !site.proc.killed) {
                site.proc.kill('SIGTERM');
            }
        });
    }

    removeDeadSites() {
        Object.keys(this.sites).forEach(domain => {
            const site = this.sites[domain];
            if (site.proc && site.proc.killed) {
                this.usedPorts.delete(site.options.env.PORT);
                delete this.sites[domain];
                console.log(`Removed dead site: ${domain}`);
            }
        });
    }
    static async attach(app,options) {
        const instance = new MultiSite(app,options);
        instance.config = new Config();
        // spawn declared sites
        if (fs.existsSync(resolve('./sites'))) {
            instance.sites = (fs.readdirSync(resolve('./sites'))).reduce((result,hostName)=>{
                const domainName = Site.GetId(hostName);
                const options = {
                    cwd: resolve(`./sites/${hostName}`),
                    env: {PORT:instance.spawnPort,meta:instance.options}
                };
                result[domainName] = Site.Spawn(domainName,options);
                return result;
            },{});
        }
        app.use('/',instance.routes());
        return instance;
    }
    routes() {
        const router = express.Router();

        router.all(/.*/, async (req, res) => {
            const domain = Site.GetId(req.hostname);
            const site = this.sites[domain];
            if (site) {
                let target = `http://127.0.0.1:${site.options.env.PORT}${req.url}`;
                const method = req.method;
                const isBodyMethod = ['POST', 'PUT', 'PATCH'].includes(method);
                const payload = isBodyMethod ? req.body : null;

                // Debug logging for POST requests
                if (method === 'POST') {
                    console.log(`[Proxy] ${method} ${target}`);
                    console.log(`[Proxy] Request body:`, req.body);
                    console.log(`[Proxy] Payload:`, payload);
                }

                const headersToForward = {
                    ...req.headers,
                    host: undefined, // Prevent host mismatch
                    'content-length': undefined // Let Axios compute
                };

                try {
                    const response = await axios({
                        method,
                        url: target,
                        headers: headersToForward,
                        data: payload,
                        params: req.query,
                        validateStatus: () => true,
                        timeout: 30000, // 30 second timeout
                    });

                    res.status(response.status).set(response.headers).send(response.data);
                } catch (error) {
                    console.error(`[Proxy] Error connecting to ${target}:`, error.message);

                    // Clean up dead processes
                    this.removeDeadSites();

                    // Try to respawn the site if it's down
                    if (error.code === 'ECONNREFUSED') {
                        console.log(`[Proxy] Attempting to respawn site for ${domain}`);
                        this.sites[domain] = Site.Clone(domain, this);
                        return res.status(503).send('Service temporarily unavailable. Please try again in a few seconds.');
                    }

                    res.status(502).send('Bad Gateway');
                }
            } else {
                this.sites[domain] = Site.Clone(domain,this);
                // Retry the request after spawning
                setTimeout(() => {
                    let target = `http://127.0.0.1:${this.sites[domain].options.env.PORT}${req.url}`;

                    res.redirect(`http://127.0.0.1:${this.sites[domain].options.env.PORT}${req.url}`);
                }, 2000);
            }
        });
        return router;
    }
}
export class Site {
    constructor(name,options={}) {
        this.name = name;
        this.options = options;
    }
    static Spawn(name, options,...args) {
        const instance = new Site(name, options);
        instance.spawn(...args);
        return instance;
    }
    static Clone(name, multisite) {
        const options = {
            cwd: process.cwd(),
            env: {PORT:multisite.spawnPort,meta:multisite.options}
        };
        const instance = new Site(name,options);
        instance.spawn();
        return instance;
    }
    spawn() {
        let commands = (['run', 'start']).concat(Array.from(arguments));
        console.log(`Spawning site ${this.name} on port ${this.options.env.PORT}`);

        try {
            this.proc = child_process.spawn('npm', commands, this.options);

            this.proc.stdout.on('data', (data) => {
                process.stdout.write(`${this.name}: ${data.toString()}`);
            });

            this.proc.stderr.on('data', (data) => {
                process.stdout.write(`${this.name}:E: ${data.toString()}`);
            });

            this.proc.on('close', (code) => {
                console.log(`${this.name}: process exited with code ${code}`);
                this.proc = null;
            });

            this.proc.on('error', (err) => {
                console.error(`${this.name}: Failed to start process:`, err);
                this.proc = null;
            });

            // Give the process time to start
            setTimeout(() => {
                if (this.proc && !this.proc.killed) {
                    console.log(`${this.name}: Successfully started on port ${this.options.env.PORT}`);
                }
            }, 1000);

        } catch (err) {
            console.error(`${this.name}: Exception while spawning:`, err);
            this.proc = null;
        }
   }
    static GetId(hostName) {
        return hostName.toLowerCase().replace(/[^a-z0-9-]+/g,'_');
    }
}
