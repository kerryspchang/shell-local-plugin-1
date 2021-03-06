/*
 * Copyright 2018 IBM Corporation
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const debug = require('debug')('local plugin')
debug('loading')

const { Docker } = require('node-docker-api'),
      dockerConfig = require('./config'),
      strings = require('./strings'),
      docs = require('./docs'),
      { kindToExtension } = require('./kinds'),
      docker = new Docker(),
      $ = require('jquery'),
      rt = require('requestretry'),        
      fs = require('fs-extra'),
      tmp = require('tmp'),
      extract = require('extract-zip');

debug('modules loaded')

/** log terminal marker in openwhisk */
const MARKER = '&XXX_THE_END_OF_A_WHISK_ACTIVATION_XXX'

const dontCreateContainer = "don't create container",
    skipInit = "skip initialization",
    dontShutDownContainer = "don't shut down container",
    htmlIncre = '<div style="-webkit-app-region: no-drag; flex: 1; display: flex"></div>',
    spinnerContent ='<div style="display: flex; flex: 1; justify-content: center; align-items: center; font-size: 1.5em; margin: 1em"><div class="replay_output" style="min-width:50%;order:2;margin-left: 1.5rem;"></div><div class="replay_spinner" style="animation: spin 2s linear infinite; font-size: 5em; color: var(--color-support-02);"><i class="fas fa-cog"></i></div></div></div>',
    debuggerURL = 'chrome-devtools://devtools/bundled/inspector.html?experiments=true&v8only=true&ws=0.0.0.0:5858';

const uuidPattern = /^[0-9a-f]{32}$/;

/** common execOptions for all of the commands */
const commandOptions = {
    needsUI: true,
    fullscreen: false, //width: 800, height: 600,
    //clearREPLOnLoad: true,
    noAuthOk: true,
    //placeholder: 'Loading visualization ...'
}

/** which commands need no command line arguments? */
const needsNoArgs = [ 'clean', 'kill', 'init' ]

let _container, _containerType, _containerCode, _imageDir, _image;



module.exports = (commandTree, prequire) => {
    const wsk = prequire('/ui/commands/openwhisk-core')
    const handler = local(wsk)
    commandTree.subtree('/local', { usage: docs.main })
    commandTree.listen('/local/invoke', handler, Object.assign({docs: strings.invoke}, commandOptions));
    commandTree.listen('/local/debug', handler, Object.assign({docs: strings.debug}, commandOptions));
    commandTree.listen('/local/init', handler, Object.assign({docs: strings.init}, commandOptions));
    commandTree.listen('/local/kill', handler, Object.assign({docs: strings.kill}, commandOptions));
    commandTree.listen('/local/clean', handler, Object.assign({docs: strings.clean}, commandOptions));

    if(typeof document === 'undefined' || typeof window === 'undefined') return; 
    
    $(window).on('beforeunload', e => {
        if(_container){
            _container.stop();
            _container.delete({ force: true });
        }        
    });   
}

/**
 * Main command handler routine
 *
 */
const local = wsk => (_a, _b, fullArgv, modules, rawCommandString, _2, argvWithoutOptions, dashOptions) => new Promise((resolve, reject) => {
    const { ui, errors } = modules

    // we always want to have "local" at the front, so e.g. invoke => local invoke
    if (argvWithoutOptions[0] && argvWithoutOptions[0] !== 'local') {
        argvWithoutOptions.unshift('local');
    }
    debug('args', argvWithoutOptions)

    if (argvWithoutOptions.length === 1) {
        debug('overall usage requested')
        reject(new errors.usage(printDocs()))

    } else if (Object.keys(strings).indexOf(argvWithoutOptions[1]) < 1) {
        // missing will be -1, 'overall' will be 0. so none of that
        debug('unknown command')
        reject(new errors.usage(printDocs()))

    } else if (argvWithoutOptions.length === 2
               && !needsNoArgs.find(_ => _ === argvWithoutOptions[1])
               && !fillInWithImplicitEntity(ui, argvWithoutOptions, 2)) { // has the user has already selected an entity in the sidecar?
        debug('insufficient args')
        reject(new errors.usage(printDocs(argvWithoutOptions[1])))

    } else {
        //
        // otherwise, we are good to go with executing the command
        //

        // parse the "-p key value" inputs
        const input = {}
        for (let i = 2; i < fullArgv.length; i++) {
            let addIndex = 0
            if (fullArgv[i] === '-p' && fullArgv[i + 1] && fullArgv[i + 1] !== '-p') {
                addIndex++
                if (fullArgv[i + 2] && fullArgv[i + 2] !== '-p') {
                    input[fullArgv[i + 1]] = fullArgv[i + 2]
                    addIndex++
                }
            }
            i += addIndex
        }

        // we use these to display incremental output in the sidecar
        const returnDiv = $(htmlIncre),
              spinnerDiv = $(returnDiv).append(spinnerContent)

        // determine bottom bar modes based on the command
        const modes = []

        if (argvWithoutOptions[1] === 'invoke') {
            debug('executing invoke command')
            let d

            Promise.all([getActionNameAndInputFromActivations(argvWithoutOptions[2], spinnerDiv),
                                getImageDir(spinnerDiv)])
                .then(([data]) => data)
                .then(updateSidecarHeader('local invoke'))
                .then(data => {d = data; return getActionCode(data.name, spinnerDiv)})   // data: code, kind, binary
                .then(data => {d = Object.assign({}, d, data)})
                .then(() => init(d.kind, spinnerDiv))
                .then(() => Date.now()) // remember the activation start time; note that this is AFTER dockerization
                .then(start => runActionInDocker(d.code, d.kind, Object.assign({}, d.param, d.input, input), d.binary, spinnerDiv)
                      .then(res => displayAsActivation('local activation', d, start, wsk, res)))
                .catch(e => appendIncreContent(e, spinnerDiv, 'error'))
        }

        else if (argvWithoutOptions[1] === 'debug') {
            debug('executing debug command')
            let d

            modes.push({ mode: 'stop-debugger', label: strings.stopDebugger, actAsButton: true,
                         direct: stopDebugger })

            Promise.all([getActionNameAndInputFromActivations(argvWithoutOptions[2], spinnerDiv),
                                getImageDir(spinnerDiv)])
                .then(([data]) => data)
                .then(updateSidecarHeader('debugger'))
                .then(data => {d = data; return getActionCode(data.name, spinnerDiv)})  // data: {code, kind}
                .then(data => {
                    if(data.kind.indexOf('node') === -1){
                        // not a node action - return
                        return Promise.reject('Currently, debugging support is limited to nodejs actions');
                    }
                    else{
                        data.kind = "nodejs:8";    // debugger only works for nodejs:8
                        d = Object.assign({}, d, data);
                        return init(d.kind, spinnerDiv);
                    }
                    
                })
                .then(() => Date.now()) // remember the activation start time; note that this is AFTER dockerization
                .then(start => runActionDebugger(d.name, d.code, d.kind, Object.assign({}, d.param, d.input, input), d.binary, modules, spinnerDiv, returnDiv, dashOptions)
                      .then(res => displayAsActivation('debug session', d, start, wsk, res)))
                .then(closeDebuggerUI)
                .then(() => debug('debug session done', result))
                .catch(e => appendIncreContent(e, spinnerDiv, 'error'))
        }

        else if (argvWithoutOptions[1] === 'init') {
            debug('executing init command')
            getImageDir(spinnerDiv)
                .then(() => init(spinnerDiv)) // this is broken, missing kind
                .then(() => {
                    appendIncreContent('Done', spinnerDiv)
                    removeSpinner(returnDiv);
                })
                .catch(e => appendIncreContent(e, spinnerDiv, 'error'))

        } else if (argvWithoutOptions[1] === 'kill') {
            debug('executing kill command')
            return kill(spinnerDiv)
                .then(() => resolve(true))
                .catch(e => appendIncreContent(e, spinnerDiv, 'error'))
            return // we will resolve the promise

        } else if (argvWithoutOptions[1] === 'clean') {
            debug('executing clean command')
            clean(spinnerDiv)
                .then(() => resolve(true))
                .catch(e => appendIncreContent(e, spinnerDiv, 'error'))
            return // we will resolve the promise
        }

        // this resolves the top-level promise, telling the repl to open the sidecar
        resolve({
            type: 'custom',
            content: returnDiv[0],
            modes
        })
    }
}) /* end of local */

/**
  * If the user has selected an entity, e.g. via a previous "action get", then fill it in
  *
  */
const fillInWithImplicitEntity = (ui, args, idx) => {
    const entity = ui.currentSelection()
    if (entity) {
        const pathAnno = entity.annotations.find(({key}) => key = 'path'),
              path = pathAnno ? `/${pathAnno.value}` : `/${entity.namespace}/${entity.name}`
        debug('implicit entity', path)
        return args[idx] = path
    }
}

/**
 * Call the OpenWhisk API to retrieve the list of docker base
 * images. The result will be cached in the _imageDir variable.
 *
 */
const getImageDir = () => {
    if(_imageDir !== undefined) {
        // we have cached it
        return Promise.resolve(_imageDir)
    } else {
        // we haven't cached it, yet
        debug('get image locations')

        return repl.qexec('host get')
            .then(data => {
                if(data.indexOf('http') != 0){
                    data = 'https://'+data;
                }

                debug('get image locations:remote call')
                return rt({
                    method: 'get',
                    rejectUnauthorized: false, // TODO we need to pull this from `wsk`
                    url : data,    
                    json: true
                });
            })
            .then(data => _imageDir = data.body.runtimes)
    }
}

/** kill and clean can tolerate non-existance of containers or images */
const squash = err => {
    console.error(err)
}

/**
 * Kill the current local docker container
 *
 */
const kill = spinnerDiv => {
    if (_container) {
        // if in this session there's a container started, remove it. 
        debug('kill from variable')
        return _container.stop()
            .then(() => _container.delete({ force: true }))
            .then(() => { _container = _containerType = _containerCode = undefined })

    } else {
        // if no docker container currently recorded, we still try
        // to kill and remove the container, in case shell crashed
        // and left a container open
        debug('kill from api')
        return docker.container.get('shell-local').status().catch(squash)
            .then(container => !container ? Promise.resolve() : container.stop().catch(squash)
                  .then(() => container.delete({ force: true })))
            .then(() => { _container = _containerType = _containerCode = undefined })
    }
}

/** flatten array of arrays */
const flatten = arrays => [].concat.apply([], arrays)

/**
 * Remove the locally pulled copy of the image
 *
 */
const clean = spinnerDiv => {
    debug('clean')
    return kill(spinnerDiv)
        .then(() => debug('kill done'))
        .then(getImageDir)
        .then(imageDir => Object.keys(imageDir).map(_ => imageDir[_]))
        .then(flatten)
        .then(x => { console.error(x); return x })
        .then(images => Promise.all(images.map(({image}) => {
            debug(`cleaning ${image}`)
            return docker.image.get(image).status().catch(squash) // catch here in case the container doesn't exist
              .then(image => {
                  if (image) {
                      return image.remove({ force: true }).catch(squash)
                  }
              })
        })))
}

/**
 * Initialize a local docker container
 *
 */
const init = (kind, spinnerDiv) => {
    appendIncreContent('Starting local container', spinnerDiv);

    return new Promise((resolve, reject) => {

        new Promise((resolve, reject) => {   

            debug('init', _containerType, kind, _container)         
            
            if(_container && (_containerType && _containerType === kind)){
                // only in one condition that we will reuse a container, is in the same shell session the same kind of action being invoked 
                debug('reusing the current container');
                resolve(dontCreateContainer);
            }
            else{
                // for all other cases, stop and delete the container, reopen a new one
                kill(spinnerDiv).then(resolve, resolve)

                // continue to the next phase no matter what: 
                // if there's any error, it will be caught when starting a container
                // delay here is small enough that it can be ignored 
            }
        })
        .then(d => {
            if(d === dontCreateContainer){
                debug('skipping docker image ls')
                return d
            }
            else{                 
                return docker.image.list()
            }            
        }) 
        .then(imageList => {
            if(imageList === dontCreateContainer){
                debug('skipping docker create')
                return imageList
            }
            else{
                // determine which dockerhub image corresponds to the
                // kind we're trying to invoke; this will be stored in
                // the image variable:
                let image = 'openwhisk/action-nodejs-v8';
                if(_imageDir){
                    //
                    // _imageDir is the output of the openwhisk `/`
                    // api, which gives some schema information,
                    // including a of this form: { nodejs: [ { kind1,
                    // image1 }, { kind2, image2 } ] }
                    //
                    try {
                        debug(`scanning imageDir for kind=${kind}`, _imageDir)
                        Object.keys(_imageDir).forEach(key => {
                            _imageDir[key].forEach(o => {
                                if(o.kind === kind){
                                    image = o.image;
                                }
                            });
                        });
                    } catch (err) {
                        console.error(err)
                        // let's hope for the best
                    }
                }
                debug('using image', image)

                debug('checking to see if the image already exists locally')
                if (imageList.find(({data}) => data.RepoTags && data.RepoTags.find(_ => _ === image))) {
                    debug('skipping docker pull, as it is already local')
                    return Promise.all([image]);
                }
                else{
                    debug('docker pull', image)
                    appendIncreContent(`Pulling image (one-time init)`, spinnerDiv);
                    return Promise.all([image, repl.qexec(`! docker pull ${image}`)]);
                }
            }
        })   
        .then(d => {
            if(!Array.isArray(d)){
                debug('skipping docker create')
                return Promise.resolve(d);
            }
            else{
                debug('docker create')
                return docker.container.create(Object.assign({Image: d[0]}, dockerConfig))
            }
        })             
        .then(d => {
            if(d === dontCreateContainer){
                debug('skipping container start')
                return Promise.resolve(_container);
            }
            else{
                debug('container start')
                _container = d; 
                _containerType = kind;            
                return _container.start(); 
            }
        })
        .then(setupLogs)
        .then(() => resolve(true))
        .catch(reject)
    });
}

/**
 * Given an activation id, determine the action name and (if possible)
 * input data for that activation.
 *
 */
const getActionNameAndInputFromActivations = (actId, spinnerDiv) => {
    if(!actId.trim().match(uuidPattern)) {
        // then actId is really an action name, so there's nothing to do here
        return Promise.resolve({name: actId, input: {}});
    }

    appendIncreContent('Retrieving activations', spinnerDiv);
    return new Promise((resolve, reject) => {
        repl.qexec(`wsk activation get ${actId}`)
        .then(d => {            
            //appendIncreContent('Retrieving the action code', spinnerDiv); 
            let name = d.name;
            if(d.annotations && Array.isArray(d.annotations)){
                d.annotations.forEach(a => {
                    if(a.key === 'path')
                        name = a.value;
                })
            }           
            return Promise.all([name, d.cause ? repl.qexec(`wsk activation get ${d.cause}`) : undefined ])
        })
        .then(arr => {
            let a = [arr[0]];   
            if(arr.length === 2 && arr[1] !== undefined){
                if(arr[1].logs.indexOf(actId) > 0){
                    // get the previous activation if there's any
                    a.push(repl.qexec(`wsk activation get ${arr[1].logs[arr[1].logs.indexOf(actId)-1]}`))
                }
            }
            return Promise.all(a);
        })
        .then(arr => {          
            resolve({name: arr[0], input: arr[1] ? arr[1].response.result : {}});    
        })
        .catch(e => reject(e));
    });
        
}

/**
 * Fetches the code for a given action
 *
 */
const getActionCode = (actionName, spinnerDiv) => {
    appendIncreContent('Fetching action', spinnerDiv);
    return repl.qexec(`wsk action get ${actionName}`)
        .then(action => {
            let param = {};
            if(action.parameters){
                action.parameters.forEach(a => {param[a.name] = a.value});
            }
            return Object.assign(action.exec, {param: param});
        })
}

/**
 * Returns a DOM that documents this plugin
 *
 */
const printDocs = (name) => {
    if(name && docs[name]){
        return docs[name]
    }
    else{
        return docs.main
    }
}

/**
 * Fetch logs from the current container
 *
 */
const setupLogs = container => {
    debug('setup logs')

    const { skip=0 } = container
    container.skip += 2 // two end markers per invoke

    if (!container.logger) {
        container.logger = container.logs({
            follow: true,
            stdout: true,
            stderr: true
        })
            .then(stream => {
                stream.on('data', info => {
                    const lines = info.toString().replace(/\n$/,'').split(/\n/) // remove trailing newline
                    let soFar = 0

                    const first = lines.indexOf(_ => _.indexOf(MARKER) >= 0),
                          slicey = first >= 0 && lines.length > 2 ? slicey + 1 : 0

                    lines.slice(slicey).forEach(line => {
                        if (line.indexOf(MARKER) >= 0) {
                            //if (soFar++ >= skip) {
                                // oh great, we found the end marker, which means we're done!
                                debug('logs are done', container.logLines)
                                container.logLineResolve(container.logLines)
                        //}
                        } else /*if (soFar >= skip)*/ {
                            // then we haven't reached the end marker, yet
                            debug('log line', line)
                            container.logLines.push(logLine('stdout', line))
                        }
                    })
                })
                stream.on('error', err => container.logLines.push(logLine('stderr', err)))
            }).catch(container.logLineReject)
    }

    container.logLinesP = new Promise((resolve, reject) => {
        container.logLines = []
        container.logLineResolve = resolve
        container.logLineReject = reject
    })
}

/**
 * Use the bits established by setupLogs to create a { result, logs } structure
 *
 */
const fetchLogs = container => result => {
    debug('fetch logs')
    if (container.logLinesP) {
        return container.logLinesP
            .then(logs => ({ result, logs }))
            .catch(err => {
                // something bad happened collecting the logs
                console.error(err)
                return { result, logs: [] }
            })
    } else {
        return { result, logs: [] }
    }
}

/**
 * Run the given code in a local docker container. We use the /init
 * and /run REST API offered by the container. If the /init call has
 * already been made, e.g. for repeated local invocations of the same
 * action, we can avoid calling /init again.
 *
 */
const runActionInDocker = (functionCode, functionKind, functionInput, isBinary, spinnerDiv) => {
    let start, init, run, end;
    return new Promise((resolve, reject) => {
        let p;
        if(_container && _containerCode === functionCode && _containerType === functionKind){
            debug('skipping init action')
            p = Promise.resolve(skipInit);
        } 
        else{
            //console.log(_container);
            debug('init action')
            appendIncreContent('Initializing action', spinnerDiv);
            start = Date.now();
            p = rt({
                method: 'post',
                url : 'http://localhost:8080/' + 'init',
                agentOptions : {
                    rejectUnauthorized : false
                },
                headers : {
                'Content-Type' : 'application/json',
                },
                json : {
                    value: {
                        code: functionCode,
                        main: 'main',
                        binary: isBinary ? isBinary : false
                    }
                }
            })
        }
        
        p.then(() => {
            _containerCode = functionCode;
            init = Date.now();
            appendIncreContent('Running the action', spinnerDiv);
            run = Date.now();
            return rt({
                method: 'post',
                url: 'http://localhost:8080/' + 'run',
                agentOptions : {
                    rejectUnauthorized: false
                },
                headers: {
                    'Content-Type' : 'application/json',
                },
                json: {
                    value: functionInput
                }
            })
        })
        .then(fetchLogs(_container))
        .then(({ result, logs }) => {
            resolve({
                init_time: start ? init-start : undefined,
                result: result.body, logs
            })
        })        
        .catch(error => {          
            if(_container && _container.stop && _container.delete){
                console.error(error);
                kill(spinnerDiv).then(() => {
                    //appendIncreContent('Done', spinnerDiv);
                    reject(error);
                }).catch(e => reject(e));                                   
            }                
            else{
                console.error(error);
                reject(error);
            }
            
        });
    });
}

/**
 * Wrap the given code with the debug harness
 *
 * @param code the text of the main code
 * @param input the JSON structure which is the input parameter
 * @param path the (container-local) output path to which we should write the result
 *
 * @return the text of the harnessed code
 */
const debugCodeWrapper = (code, input, path) => {
    return `

${code}





// below is the debugger harness
const debugMainFunc = exports.main || main
Promise.resolve(debugMainFunc(${JSON.stringify(input)}))
  .then(result => require('fs').writeFileSync('${path}', JSON.stringify(result)))`
}

/**
 * Run the given code inside a local debugging session
 *
 */
const runActionDebugger = (actionName, functionCode, functionKind, functionInput, isBinary, { ui }, spinnerDiv, returnDiv, dashOptions) => new Promise((resolve, reject) => {
    appendIncreContent('Preparing container', spinnerDiv)

    // this specifies a path inside docker container, so we should not
    // need to worry about hard-coding something here
    const resultFilePath = '/tmp/debug-session.out';

    // we need to amend the functionCode with a prolog that writes the
    // result somewhere we can find
    let fileCode, entry;
    if(isBinary){
        // then "fileCode" is really the zip contents; we'll extract this below
        fileCode = functionCode;
    }
    else{
        // otherwise, this is a plain action
        fileCode = debugCodeWrapper(functionCode, functionInput, resultFilePath);
    }

    // note that we use the action's name (e.g. myAction.js) as the
    // file name, so that it appears nicely in call stacks and other
    // line numbery displays in the debugger
    let debugFileName;  
    if(isBinary){
        debugFileName = actionName+'.zip';  // for zip actions, use .zip as the extension name
    }
    else {   
        debugFileName = actionName.substring(actionName.lastIndexOf('/') + 1)
          + (kindToExtension[functionKind.replace(/:.*$/,'')] || '');
    }

    //
    // write out our function code, copy it into the docker container,
    // then spawn the debugger, and finally wait for the debug session
    // to complete; at that point, we resolve with { result, logs }
    //

    // first, create a local temp folder
    createTempFolder().then(({path:dirPath, cleanupCallback}) => {  
        const containerFolderPath = dirPath.substring(dirPath.lastIndexOf('/') + 1)

        fs.outputFile(`${dirPath}/${debugFileName}`, fileCode, isBinary?'base64':undefined) // write file to that local temp folder
        .then(() => new Promise((resolve, reject) => {                
            if(isBinary){   // if it is a zip action, unzip first
                extract(`${dirPath}/${debugFileName}`, { dir: `${dirPath}` }, function (err) {
                    if(err){
                        reject(err);
                    }
                    else{
                        // see if a package.json exists; if so read it
                        // in, because there may be a "main" field
                        // that indicates the name of the file which
                        // includes the main routine
                        const packageJsonPath = `${dirPath}/package.json`
                        fs.pathExists(packageJsonPath)
                            .then(exists => {
                                if (exists) {
                                    // yup, we found a package.json, now see if it has a main field
                                    return fs.readFile(packageJsonPath)
                                        .then(data => JSON.parse(data).main || 'index.js') // backup plan: index.js
                                } else {
                                    // nope, no package.json, so use the default main file
                                    return 'index.js'
                                }
                            })
                            .then(entry => fs.readFile(`${dirPath}/${entry}`)  // read in the entry code, so we can wrap it with debug
                                  .then(data => debugCodeWrapper(data.toString(), functionInput, resultFilePath)) // wrap it!
                                  .then(newCode => fs.outputFile(`${dirPath}/${entry}`, newCode)) // write the new file to temp directory
                                  .then(() => resolve(entry))) // return value: the location of the entry
                            .catch(reject)
                    }
                })
            } else {
                // otherwise, this is a plain (not zip) action
                entry = debugFileName;
                resolve(entry) // return value: the location of the entry
            }
        }))  
        .then(entry => repl.qexec(`! docker cp ${dirPath} shell-local:/nodejsAction`) // copy temp dir into container
              .then(() => appendIncreContent('Launching debugger', spinnerDiv))    // status update
              .then(() => entry))
        .then(entry => {
            // this is where we launch the local debugger, and wait for it to terminate
            // as to why we need to hack for the Waiting for debugger on stderr:
            // https://bugs.chromium.org/p/chromium/issues/detail?id=706916
            const logLines = []
            repl.qexec(`! docker exec shell-local node --inspect-brk=0.0.0.0:5858 ${containerFolderPath}/${entry}`, undefined, undefined,
                       { stdout: line => logLines.push(logLine('stdout', line)),
                         stderr: line => {
                           if (line.indexOf('Waiting for the debugger to disconnect') >= 0) {
                               repl.qexec(`! docker cp shell-local:${resultFilePath} ${dirPath}/debug-session.out`)
                                   .then(() => fs.readFile(`${dirPath}/debug-session.out`))
                                   .then(result => JSON.parse(result.toString()))
                                   .then(result => { cleanupCallback(); return result; }) // clean up tmpPath
                                   .then(result => resolve({ result,
                                                             logs: logLines }))
                           } else if (line.indexOf('Debugger listening on') >= 0) {
                               // squash
                           } else if (line.indexOf('For help see https://nodejs.org/en/docs/inspector') >= 0) {
                               // squash
                           } else if (line.indexOf('Debugger attached') >= 0) {
                               // squash
                           } else {
                               // otherwise, hopefully this is a legit application log line
                               logLines.push(logLine('stderr', line))
                           }
                       } }).catch(reject)
        })
        // now, we fetch the URL exported by the local debugger
        // and use this URL to open a webview container around it
        .then(() => rt({ method: 'get', url: 'http://0.0.0.0:5858/json', json: true}))   // fetch url...
        .then(data => {
            // here, we extract the relevant bits of the URL from the response
            if(data && data.body && data.body.length > 0 && data.body[0].devtoolsFrontendUrl) {
                return data.body[0].devtoolsFrontendUrl.substring(data.body[0].devtoolsFrontendUrl.lastIndexOf('/'));
            }
        })
        .then(backtag => {
            // and make webview container from it!
            if (backtag) {
                // remove the spinnery bits
                ui.removeAllDomChildren(returnDiv[0])

                // create and attach the webview
                const webview = $(`<div id="debuggerDiv" style="flex: 1; display: flex"><webview style="flex:1" src="${debuggerURL}${backtag}" autosize="on"></webview></div>`);
                $(returnDiv).append(webview)

                // avoid the repl capturing mouse clicks
                $(webview).mouseup(e => {e.stopPropagation();})
            }
        })
       .catch(reject)
    })
})

/**
  * Determine whether this is user error or internal (our) error
  *
  */
const isUserError = error => {
    if (error.statusCode === 404) {
        // then this is probably a normal "action not found" error
        // from the backend; display the backend's message,to be
        // compatible with the REPL's experience
        return true
    } else {
        return false
    }
}

/**
 * Add a status message
 *
 */
const appendIncreContent = (content, div, error) => {
    if(div === undefined){
        console.error('Error: content div undefined. content='+content);
        return;
    }

    if (error) {
        console.error(content)

        // tell the spinner to change to an error icon
        errorSpinner(div)

        // format the error message
        const err = content,
              message = isUserError(err) ? ui.oopsMessage(err) : 'Internal Error'

        // and then display it
        $(div).find('.replay_output').append(`<div style='padding-top:0.25ex' class='red-text fake-in'>${message}</div>`);
    }
    else if(typeof content === 'string') {
        $(div).find('.replay_output').append(`<div style='padding-top:0.25ex' class='fade-in'>${content}</div>`);
    } else if(content.response){
         $(div).find('.replay_output').append(`<div><span style="white-space:pre;" class='fade-in'>${JSON.stringify(content, null, 4)}<span></div>`);
    }
    else{        
        $(div).find('.replay_output').append(content);
    }

}

/**
 * Remove the appendIncreContent dom bits, i.e. the status messages
 *
 */
const removeSpinner = div => {
    $(div).children('.replay_spinner').remove();
}

/**
 * Display a given icon in place of the spinner icon
 *
 */
const iconForSpinner = (spinnerDiv, icon, extraCSS) => {
    const iconContainer = $(spinnerDiv).find('.replay_spinner')
    $(iconContainer).css('animation', '')
    $(iconContainer).css('color', '')
    if (extraCSS) $(iconContainer).addClass(extraCSS)
    $(iconContainer).empty()
    $(iconContainer).append(`<i class="${icon}"></i>`)
}
const errorSpinner = spinnerDiv => iconForSpinner(spinnerDiv, 'fas fa-exclamation-triangle', 'red-text')
const okSpinner = spinnerDiv => iconForSpinner(spinnerDiv, 'fas fa-thumbs-up', 'green-text')

/**
 * Update the sidecar header to reflect the given viewName and entity
 * name stored in data.
 *
 */
const updateSidecarHeader = viewName => data => {
    const { name } = data,
          split = name.split('/'),
          packageName = split.length > 3 ? split[2] : undefined,
          actionName = split[split.length - 1],
          onclick = () => repl.pexec(`action get ${name}`)

    ui.addNameToSidecarHeader(undefined, actionName, packageName, onclick, viewName)

    data.actionName = actionName
    data.packageName = packageName

    return data
}

/**
 * @return a timestamp compatible with OpenWhisk logs
 *
 */
const timestamp = (date=new Date()) => date.toISOString()

/**
 * Make an OpenWhisk-compatible log line
 *
 */
const logLine = (type, line) => `${timestamp()} stdout: ${line.toString()}`

/**
 * Write the given string to a temp file
 *
 * @return {tmpPath, cleanupCallback}
 *
 */
const writeToTempFile = string => new Promise((resolve, reject) => {
    tmp.file((err, tmpPath, fd, cleanupCallback) => {
        if (err) {
            console.error(res.err)
            reject('Internal Error')
        } else {
            return fs.outputFile(tmpPath, string).then(() => resolve({tmpPath, cleanupCallback}))
        }
    })
})


const createTempFolder = () => new Promise((resolve, reject) => {
    tmp.dir({unsafeCleanup: true}, function _tempDirCreated(err, path, cleanupCallback) {
        if (err) {
            console.error(err)
            reject('Internal Error')
        }
        else{
            resolve({path: path, cleanupCallback: cleanupCallback});
        }
      //console.log('Dir: ', path);
     
    });
});
/**
*
*
*/
const displayAsActivation = (sessionType, { kind, actionName, name }, start, { activationModes }, {result, logs, init_time}) => {
    try {
        // when the session ended
        const end = Date.now()

        const annotations = [ { key: 'path', value: `${namespace.current()}/${name}` },
                              { key: 'kind', value: kind }]

        if (init_time) {
            // fake up an initTime annotation
            annotations.push({ key: 'initTime', value: init_time })
        }

        // fake up an activation record and show it
        ui.showEntity(activationModes({ type: 'activations',
                                        activationId: sessionType,  // e.g. "debug session"
                                        name: actionName,
                                        annotations,
                                        statusCode: 0,     // FIXME
                                        start, end,
                                        duration: end - start,
                                        logs,
                                        response: {
                                            success: true, // FIXME
                                            result
                                        }
                                      }))
    } catch (err) {
        console.error(err)
    }
}

/**
 * Clean up the debugger UI
 *
 */
const closeDebuggerUI = ({closeSidecar=false}={}) => {
    $('#debuggerDiv').remove()
}

/**
 * Clean up the debugger UI and close the sidecar
*
*/
const stopDebugger = () => {
    closeDebuggerUI()
    ui.clearSelection()
}

debug('loading done')
