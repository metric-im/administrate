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
        this.healthCheckIntervals = new Map();
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

    async cleanup() {
        console.log('Cleaning up spawned processes...');
        const promises = Object.values(this.sites).map(async (site) => {
            if (site.proc && !site.proc.killed) {
                return new Promise((resolve) => {
                    const timeout = setTimeout(() => {
                        if (!site.proc.killed) {
                            console.log(`Force killing ${site.name} after timeout`);
                            site.proc.kill('SIGKILL');
                        }
                        resolve();
                    }, 10000); // 10 second timeout for graceful shutdown

                    site.proc.kill('SIGTERM');

                    site.proc.on('exit', () => {
                        console.log(`${site.name} process terminated gracefully`);
                        clearTimeout(timeout);
                        resolve();
                    });
                });
            }
        });

        await Promise.all(promises.filter(Boolean));

        // Clear all health check intervals
        this.healthCheckIntervals.forEach(interval => clearInterval(interval));
        this.healthCheckIntervals.clear();

        console.log('All spawned processes cleaned up');
    }

    startHealthCheck(site) {
        const intervalId = setInterval(async () => {
            if (!site.proc || site.proc.killed) {
                clearInterval(intervalId);
                this.healthCheckIntervals.delete(site.name);
                return;
            }

            try {
                await axios.get(`http://127.0.0.1:${site.options.env.PORT}/health`, {
                    timeout: 5000,
                    validateStatus: () => true
                });
            } catch (error) {
                if (error.code === 'ECONNREFUSED' || error.code === 'ETIMEDOUT') {
                    console.log(`Health check failed for ${site.name}, marking for restart...`);
                    clearInterval(intervalId);
                    this.healthCheckIntervals.delete(site.name);

                    // Mark the process as failed for cleanup
                    if (site.proc && !site.proc.killed) {
                        site.proc.kill('SIGTERM');
                    }
                }
            }
        }, 30000); // Check every 30 seconds

        this.healthCheckIntervals.set(site.name, intervalId);
    }

    restartSite(domain) {
        const oldSite = this.sites[domain];
        if (oldSite) {
            // Clear health check
            const intervalId = this.healthCheckIntervals.get(oldSite.name);
            if (intervalId) {
                clearInterval(intervalId);
                this.healthCheckIntervals.delete(oldSite.name);
            }

            // Kill old process
            if (oldSite.proc && !oldSite.proc.killed) {
                oldSite.proc.kill('SIGTERM');
            }

            // Remove from used ports
            this.usedPorts.delete(oldSite.options.env.PORT);
        }

        // Create new site
        this.sites[domain] = Site.Clone(domain, this);
        console.log(`Restarted site for domain: ${domain}`);
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
                result[domainName] = Site.Spawn(domainName,options,instance);
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
                    'content-length': undefined // Let Axios compute
                };


                try {
                    // Determine if this is a binary file request
                    const isBinaryRequest = /\.(woff2?|ttf|eot|otf|ico|png|jpe?g|gif|svg|pdf|zip|exe)(\?.*)?$/i.test(req.url);
                    
                    const response = await axios({
                        method,
                        url: target,
                        headers: headersToForward,
                        data: payload,
                        params: req.query,
                        validateStatus: () => true,
                        timeout: 30000, // 30 second timeout
                        responseType: isBinaryRequest ? 'arraybuffer' : 'text'
                    });
console.log(`${response.status} ${target}`);
                    // Clean up response headers that might cause issues
                    const cleanHeaders = {...response.headers};
                    delete cleanHeaders['transfer-encoding'];
                    delete cleanHeaders['content-encoding'];
                    
                    if (isBinaryRequest) {
                        res.status(response.status).set(cleanHeaders).send(Buffer.from(response.data));
                    } else {
                        res.status(response.status).set(cleanHeaders).send(response.data);
                    }
                } catch (error) {
                    console.error(`[Proxy] Error connecting to ${target}:`, error.message);

                    // // Clean up dead processes
                    // this.removeDeadSites();
                    //
                    // // Try to respawn the site if it's down
                    // if (error.code === 'ECONNREFUSED') {
                    //     console.log(`[Proxy] Attempting to respawn site for ${domain}`);
                    //     this.sites[domain] = Site.Clone(domain, this);
                    //     return res.status(503).send('Service temporarily unavailable. Please try again in a few seconds.');
                    // }

                    res.status(502).send('Bad Gateway. Try reloading.');
                }
            } else {
                this.sites[domain] = Site.Clone(domain,this);
                // Retry the request after spawning
                setTimeout(() => {
                    res.redirect(`//${req.hostname}${req.url}`);
                }, 2000);
            }
        });
        return router;
    }
}
export class Site {
    constructor(name,options={},parent) {
        this.name = name;
        this.options = options;
        this.parent = parent;
    }
    static Spawn(name, options, parent) {
        const instance = new Site(name, options, parent);
        instance.spawn();
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
        let commands = (['run', 'start', this.name]);
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

                // Clear health check when process exits
                if (this.healthCheckIntervals) {
                    const intervalId = this.healthCheckIntervals.get(this.name);
                    if (intervalId) {
                        clearInterval(intervalId);
                        this.healthCheckIntervals.delete(this.name);
                    }
                }
            });

            this.proc.on('error', (err) => {
                console.error(`${this.name}: Failed to start process:`, err);
                this.proc = null;
            });

            // Give the process time to start, then begin health checks
            setTimeout(() => {
                if (this.proc && !this.proc.killed) {
                    console.log(`${this.name}: Successfully started on port ${this.options.env.PORT}`);

                    // Start health monitoring after a delay to allow process to fully start
                    if (this.startHealthCheck) {
                        setTimeout(() => {
                            if (this.proc && !this.proc.killed) {
                                this.startHealthCheck(this);
                            }
                        }, 5000); // Wait 5 seconds before starting health checks
                    }
                }
            }, 1000);

        } catch (err) {
            console.error(`${this.name}: Exception while spawning:`, err);
            this.proc = null;
        }
   }
    static GetId(hostName="") {
        return hostName.toLowerCase().replace(/[^a-z0-9-]+/g,'_');
    }
}
