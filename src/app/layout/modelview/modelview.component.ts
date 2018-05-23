import { Component, ViewChild, AfterViewInit, Renderer2, ElementRef } from '@angular/core';
import { routerTransition } from '../../router.animations';
import { ModelInfoService, ModelPartCallbackType,
         ModelPartStateChange, ModelPartStateChangeType } from '../../shared/services/model-info.service';
import { SidebarService, MenuChangeType, MenuStateChangeType } from '../../shared/services/sidebar.service';

// Include threejs library
import * as THREE from 'three';

// GLTFLoader is not part of threejs' set of package exports, so we need this wrapper function
// FIXME: Needs typescript bindings
import * as GLTFLoader from '../../../../node_modules/three-gltf2-loader/lib/main';

// Import itowns library
// FIXME: Needs typescript bindings
import * as ITOWNS from '../../../../node_modules/itowns/dist/itowns';

// If you want to use your own CRS instead of the ITOWNS' default one then you must use ITOWNS' version of proj4
const proj4 = ITOWNS.proj4;

// Three axis virtual globe controller
// FIXME: Needs typescript bindings
import GeoModelControls from '../../../assets/GeoModelControls';

// Detects if WebGL is available in the browser
import * as Detector from '../../../../node_modules/three/examples/js/Detector';

const BACKGROUND_COLOUR = new THREE.Color(0x777777);

@Component({
    selector: 'app-modelview',
    templateUrl: './modelview.component.html',
    styleUrls: ['./modelview.component.scss'],
    animations: [routerTransition()]
})
export class ModelViewComponent  implements AfterViewInit {
    @ViewChild('viewerDiv') private viewerDivElem: ElementRef;
    @ViewChild('popupBoxDiv') private popupBoxDivElem: ElementRef;

    // iTowns extent object
    private extentObj;

    // <div> where the 3d objects are displayed
    private viewerDiv = null;

    // <div> where popup information boxes live
    private popupBoxDiv = null;

    // view object
    private view;

    // scene object
    private scene;

    // Dictionary of {scene, checkbox, group name} objects used by model controls div, key is model URL
    private sceneArr = {};

    // camera object
    private camera;

    // renderer object
    private renderer;

    // track ball controls object
    private trackBallControls;

    // raycaster object
    private raycaster;

    // mouse object
    private mouse = new THREE.Vector2();

    // configuration object
    private config;

    // directory where model files are kept
    private model_dir;

    constructor(private modelInfoService: ModelInfoService, private elRef: ElementRef, private ngRenderer: Renderer2,
                private sidebarService: SidebarService) {
    }

    ngAfterViewInit() {
        this.viewerDiv = this.viewerDivElem.nativeElement;
        this.popupBoxDiv = this.popupBoxDivElem.nativeElement;
        const local = this;

        // Detect if webGL is available and inform viewer if cannot proceed
        if (Detector.webgl) {
            const params = new URLSearchParams(document.location.search.substring(1));
            const model_name = 'NorthGawler';  // FIXME: should eventually be params.get('model');
            // Initialise model by downloading its JSON file
            this.modelInfoService.getModelInfo(model_name).then(res => { local.initialiseModel(res, model_name); });
            const callbackFn: ModelPartCallbackType =  function(groupName: string, partId: string, state: ModelPartStateChange) {
                if (state.type === ModelPartStateChangeType.DISPLAYED) {
                    // local.printMeshes();
                    local.sceneArr[groupName][partId].visible = state.new_value;
                    // local.printMeshes();
                    local.view.notifyChange(true);
                } else if (state.type ===  ModelPartStateChangeType.TRANSPARENCY) {
                    local.setPartTransparency(local.sceneArr[groupName][partId], <number> state.new_value);
                    local.view.notifyChange(true);
                } else if (state.type === ModelPartStateChangeType.HEIGHT_OFFSET) {
                    const displacement = new THREE.Vector3(0.0, 0.0, <number> state.new_value);
                    local.movePart(local.sceneArr[groupName][partId], displacement);
                    local.view.notifyChange(true);
                }
            };
            this.modelInfoService.registerModelPartCallback(callbackFn);
        } else {
            const warning = Detector.getWebGLErrorMessage();
            this.ngRenderer.appendChild(this.viewerDiv, warning);
        }
    }

    private printMeshes() {
        for (const child of this.scene.children) {
            if (child instanceof THREE.Mesh) {
                console.log(child.name, JSON.stringify(child));
            }
        }
    }

    private addPart(part, sceneObj: THREE.Object3D, groupName: string) {
        if (!this.sceneArr.hasOwnProperty(groupName)) {
            this.sceneArr[groupName] = {};
        }
        this.sceneArr[groupName][part.model_url] = sceneObj;
    }

    private movePart(sceneObj: THREE.Object3D, displacement: THREE.Vector3) {
        sceneObj.traverseVisible( function(child) {
            if (child instanceof THREE.Object3D) {
                if (!child.userData.hasOwnProperty('origPosition')) {
                    child.userData.origPosition = child.position.clone();
                }
                child.position.addVectors(child.userData.origPosition, displacement);
            }
        });
    }

    private setPartTransparency(sceneObj: THREE.Object3D, value: number) {
        // Plane objects
        if (sceneObj instanceof THREE.Mesh && sceneObj.material instanceof THREE.MeshBasicMaterial) {
            const material: THREE.MeshBasicMaterial = sceneObj.material;
            if (value >= 0.0 && value < 1.0) {
                material.transparent = true;
                material.opacity = value;
            } else if (value === 1.0) {
                material.transparent = false;
                material.opacity = 1.0;
            }
        } else {
            // GLTF objects
            sceneObj.traverseVisible( function(child) {
                if (child instanceof THREE.Mesh) {
                    if (child.material instanceof THREE.MeshStandardMaterial) {
                        const material: THREE.MeshStandardMaterial = child.material;
                        if (value >= 0.0 && value < 1.0) {
                            material.transparent = true;
                            material.opacity = value;
                        } else if (value === 1.0) {
                            material.transparent = false;
                            material.opacity = 1.0;
                        }
                    }
                }
            });
        }
    }

    private initialiseModel(config, modelName: string) {
        const props = config.properties;
        const i = 0;
        console.log('config =', config, modelName);
        this.config = config;
        this.model_dir = modelName;
        if (props.proj4_defn) {
            proj4.defs(props.crs, props.proj4_defn);
        }

        // Define geographic extent: CRS, min/max X, min/max Y
        // Model boundary according to the North Gawler Province Metadata PDF using projection: UTM Zone 52 Datum: GDA94 => EPSG:28352
        this.extentObj = new ITOWNS.Extent(props.crs, props.extent[0], props.extent[1], props.extent[2], props.extent[3]);

        this.sceneArr = {};

        // Scene
        this.scene = new THREE.Scene();

        /*var axesHelper = new THREE.AxisHelper( 5 );
        scene.add( axesHelper );*/

        // Grey background
        this.scene.background = BACKGROUND_COLOUR;

        // Ambient light
        const ambient = new THREE.AmbientLight(0xFFFFFF);
        ambient.name = 'Ambient Light';
        this.scene.add(ambient);

        // Point light
        const pointlight = new THREE.PointLight();
        pointlight.position.set(this.extentObj.west(), this.extentObj.south(), 400000);
        pointlight.name = 'Point Light';
        this.scene.add(pointlight);

        // this.addPlanes();
        this.add3DObjects();
    }

    // Add GLTF objects
    private add3DObjects() {
        const manager = new THREE.LoadingManager();

        // This adds the 'GLTFLoader' object to 'THREE'
        GLTFLoader(THREE);

        // Create our new GLTFLoader object
        const loader = new THREE['GLTFLoader'](manager);
        const promiseList = [];
        const local = this;

        // Load GLTF objects into scene
        for (const group in this.config.groups) {
            if (this.config.groups.hasOwnProperty(group)) {
                const parts = this.config.groups[group];
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].type === 'GLTFObject' && parts[i].include) {
                        promiseList.push( new Promise( function( resolve, reject ) {
                            (function(part, grp) {
                                loader.load('./assets/geomodels/' + local.model_dir + '/' + part.model_url,
                                    // function called if loading successful
                                    function (g_object) {
                                        console.log('loaded: ', local.model_dir + '/' + part.model_url);
                                        g_object.scene.name = part.model_url;
                                        if (!part.displayed) {
                                            g_object.scene.visible = false;
                                        }
                                        local.scene.add(g_object.scene);
                                        local.addPart(part, g_object.scene, grp);
                                        resolve(g_object.scene);
                                    },
                                    // function called during loading
                                    function ( xhr ) {
                                        // console.log('GLTF/OBJ onProgress()', xhr);
                                        // if ( xhr.lengthComputable ) {
                                        //    const percentComplete = xhr.loaded / xhr.total * 100;
                                        //    console.log( xhr.currentTarget.responseURL, Math.round(percentComplete) + '% downloaded' );
                                        // }
                                    },
                                    // function called when loading fails
                                    function ( xhr ) {
                                         console.log('GLTF/OBJ load error!', xhr);
                                         reject(null);
                                    }
                                );
                            })(parts[i], group);
                        }));
                    }
                }
            }
        }

        Promise.all(promiseList).then(
            // function called when all objects are loaded
            function( sceneObjList ) {
                console.log('GLTFs are loaded, now init view scene=', local.scene);
                // local.initialiseView(local.config);
                local.addPlanes();
            },
            // function called when one object fails
            function( error ) {
                console.error( 'Could not load all textures:', error );
            });
    }


    private addPlanes() {
        // Add planes
        const manager = new THREE.LoadingManager();
        manager.onProgress = function ( item, loaded, total ) {
            // console.log( item, loaded, total );
        };

        const local = this;
        const textureLoader = new THREE.TextureLoader(manager);
        const promiseList = [];
        for (const group in this.config.groups) {
            if (this.config.groups.hasOwnProperty(group)) {
                const parts = this.config.groups[group];
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].type === 'ImagePlane' && parts[i].include) {
                        promiseList.push( new Promise( function( resolve, reject ) {
                        (function(part, grp) {
                          const texture = textureLoader.load('./assets/geomodels/' + local.model_dir + '/' + part.model_url,
                            // Function called when download successful
                            function (textya) {
                                textya.minFilter = THREE.LinearFilter;
                                const material = new THREE.MeshBasicMaterial( {
                                    map: textya,
                                   side: THREE.DoubleSide
                                } );
                                const geometry = new THREE.PlaneGeometry(local.extentObj.dimensions().x, local.extentObj.dimensions().y);
                                const plane = new THREE.Mesh(geometry, material);
                                const position = new THREE.Vector3(local.extentObj.center().x(),
                                                                      local.extentObj.center().y(), part.position[2]);
                                plane.position.copy(position);
                                plane.name = part.display_name; // Need this to display popup windows
                                local.scene.add(plane);
                                local.addPart(part, plane, grp);
                                resolve(plane);
                            },
                            // Function called when download progresses
                            function ( xhr ) {
                                // console.log((xhr.loaded / xhr.total * 100) + '% loaded');
                            },
                            // Function called when download errors
                            function ( xhr ) {
                                console.error('An error happened loading image plane');
                                reject(null);
                            }
                          );
                       })(parts[i], group);
                        }));
                    }
                }
            }
        }

        Promise.all(promiseList).then(
        // function called when all objects successfully loaded
        function( sceneObjList ) {
           // Planes are loaded, now for GLTF objects
           //  local.add3DObjects();
           local.initialiseView(local.config);
        },
        // function called when one GLTF object failed to load
        function( error ) {
            console.error( 'Could not load all textures:', error );
        });
    }

    // NOTA BENE: The view objects must be added AFTER all the objects that are added to the scene directly.
    // Itowns code assumes that only its view objects have been added to the scene, and gets confused when there are
    // other objects in the scene.
    //
    private initialiseView(config) {
        const props = config.properties;
        const local = this;

        // Create an instance of PlanarView
        console.log('PlanarView():', this.viewerDiv, this.extentObj, this.renderer, this.scene);
        // debugger;
        this.view = new ITOWNS.PlanarView(this.viewerDiv, this.extentObj,
                               {near: 0.001, renderer: this.renderer, scene3D: this.scene});

        // Change defaults to allow the camera to get very close and very far away without exceeding boundaries of field of view
        this.view.camera.camera3D.near = 0.01;
        this.view.camera.camera3D.far = 200 * Math.max(this.extentObj.dimensions().x, this.extentObj.dimensions().y);
        this.view.camera.camera3D.updateProjectionMatrix();
        this.view.camera.camera3D.updateMatrixWorld(true);

        // Disable ugly tile skirts
        this.view.tileLayer.disableSkirt = true;

        // Add WMS layers
        for (const group of config.groups) {
            if (this.config.groups.hasOwnProperty(group)) {
                const parts = config.groups[group];
                for (let i = 0; i < parts.length; i++) {
                    if (parts[i].type === 'WMSLayer' && parts[i].include) {
                        this.view.addLayer({
                            url: parts[i].model_url,
                            networkOptions: { crossOrigin: 'anonymous' },
                            type: 'color',
                            protocol: 'wms',
                            version: parts[i].version,
                            id: parts[i].id,
                            name: parts[i].name,
                            projection: props.crs,
                            options: {
                                mimetype: 'image/png',
                            },
                            updateStrategy: {
                                type: ITOWNS.STRATEGY_DICHOTOMY,
                                options: {},
                            },
                        }).then(this.refresh);
                    }
                }
            }
        }

        // The Raycaster is used to find which part of the model was clicked on, then create a popup box
        this.raycaster = new THREE.Raycaster();
        this.ngRenderer.listen(this.viewerDiv, 'dblclick', function(event: any) {

                event.preventDefault();

                const modelViewObj = local;

                modelViewObj.mouse.x = (event.offsetX / local.viewerDiv.clientWidth) * 2 - 1;
                modelViewObj.mouse.y = -(event.offsetY / local.viewerDiv.clientHeight) * 2 + 1;

                modelViewObj.raycaster.setFromCamera(modelViewObj.mouse, modelViewObj.view.camera.camera3D);

                const intersects  = modelViewObj.raycaster.intersectObjects(modelViewObj.scene.children, true);

                // Look at all the intersecting objects to see that if any of them have information for popups
                if (intersects.length > 0) {
                    for (let n = 0; n < intersects.length; n++) {
                        if (intersects[n].object.name === '') {
                            continue;
                        }
                        for (const group in modelViewObj.config.groups) {
                            if (modelViewObj.config.groups.hasOwnProperty(group)) {
                                const parts = modelViewObj.config.groups[group];
                                for (let i = 0; i < parts.length; i++) {
                                    if (parts[i].hasOwnProperty('popups')) {
                                        for (const popup_key in parts[i]['popups']) {
                                            if (parts[i]['popups'].hasOwnProperty(popup_key)) {
                                                if (popup_key + '_0' === intersects[n].object.name) {
                                                    modelViewObj.makePopup(event, parts[i]['popups'][popup_key]);
                                                    if (parts[i].hasOwnProperty('model_url')) {
                                                        modelViewObj.openSidebarMenu(group, parts[i]['model_url']);
                                                    }
                                                    return;
                                                }
                                            }
                                        }
                                    // FIXME: Update config file and this so that we only use 'popups' code above
                                    } else if (parts[i].hasOwnProperty('3dobject_label') &&
                                           parts[i].hasOwnProperty('popup_info') &&
                                           intersects[n].object.name === parts[i]['3dobject_label'] + '_0') {
                                        modelViewObj.makePopup(event, parts[i]['popup_info']);
                                        if (parts[i].hasOwnProperty('model_url')) {
                                            modelViewObj.openSidebarMenu(group, parts[i]['model_url']);
                                        }
                                        return;
                                    } else if (parts[i].hasOwnProperty('3dobject_label') &&
                                           intersects[n].object.name === parts[i]['3dobject_label'] &&
                                           parts[i].hasOwnProperty('reference')) {
                                        window.open(parts[i]['reference']);
                                        return;
                                    }
                                }
                            }
                        }
                    }
                }
            });

        // Insert some arrows to give us some orientation information
        const x_dir = new THREE.Vector3( 1, 0, 0 );
        const y_dir = new THREE.Vector3( 0, 1, 0 );
        const z_dir = new THREE.Vector3( 0, 0, 1 );

        const origin = new THREE.Vector3( );
        origin.copy(this.extentObj.center().xyz());

        const length = 150000;
        const hex_x = 0xff0000;
        const hex_y = 0x00ff00;
        const hex_z = 0x0000ff;

        const arrowHelper_x = new THREE.ArrowHelper( x_dir, origin, length, hex_x );
        arrowHelper_x.name = 'arrowHelper_x';
        this.scene.add( arrowHelper_x );
        const arrowHelper_y = new THREE.ArrowHelper( y_dir, origin, length, hex_y );
        arrowHelper_y.name = 'arrowHelper_y';
        this.scene.add( arrowHelper_y );
        const arrowHelper_z = new THREE.ArrowHelper( z_dir, origin, length - 50000, hex_z );
        arrowHelper_z.name = 'arrowHelper_z';
        this.scene.add( arrowHelper_z );

        // 3 axis virtual globe controller
        const trackBallControls = new GeoModelControls(this.view.camera.camera3D, this.view, this.extentObj.center().xyz());
        this.scene.add(trackBallControls.getObject());

        console.log('scene = ', this.scene);
        this.view.notifyChange(true);
    }

    makePopup(event, popupInfo) {
        const local = this;
        // Position it and let it be seen
        this.ngRenderer.setStyle(this.popupBoxDiv, 'top', event.clientY);
        this.ngRenderer.setStyle(this.popupBoxDiv, 'left', event.clientX);
        this.ngRenderer.setStyle(this.popupBoxDiv, 'display', 'inline');
        // Empty its contents using DOM operations (Renderer2 does not currently support proper element querying)
        while (this.popupBoxDiv.hasChildNodes()) {
            this.popupBoxDiv.removeChild(this.popupBoxDiv.lastChild);
        }

        // // Make 'X' for exit button in corner of popup window
        const exitDiv = this.ngRenderer.createElement('div');
        this.ngRenderer.setAttribute(exitDiv, 'id', 'popupExitDiv');  // Attributes are HTML entities
        this.ngRenderer.addClass(exitDiv, 'popupClass');
        this.ngRenderer.setProperty(exitDiv, 'innerHTML', 'X'); // Properties are DOM entities
        this.ngRenderer.setProperty(exitDiv, 'onclick', function() { local.ngRenderer.setStyle(local.popupBoxDiv, 'display', 'none'); });
        this.ngRenderer.appendChild(this.popupBoxDiv, exitDiv);
        // Make popup title
        const hText = this.ngRenderer.createText(popupInfo['title']);
        this.ngRenderer.appendChild(this.popupBoxDiv, hText);
        // Add in popup information
        for (const key in popupInfo) {
             if (key !== 'href' && key !== 'title') {
                const liElem = this.ngRenderer.createElement('li');
                const spElem = this.ngRenderer.createElement('span');
                const keyText = this.ngRenderer.createText(key);
                const valText = this.ngRenderer.createText(': ' + popupInfo[key]);
                this.ngRenderer.appendChild(spElem, keyText);
                this.ngRenderer.appendChild(liElem, spElem);
                this.ngRenderer.appendChild(liElem, valText);
                this.ngRenderer.addClass(liElem, 'popupClass');
                this.ngRenderer.appendChild(this.popupBoxDiv, liElem);
            // Make URLs
            } else if (key === 'href') {
                for (let hIdx = 0; hIdx < popupInfo['href'].length; hIdx++) {
                    const liElem = this.ngRenderer.createElement('li');
                    const oLink = this.ngRenderer.createElement('a');
                    this.ngRenderer.setAttribute(oLink, 'href', popupInfo['href'][hIdx]['URL']); // Attributes are HTML entities
                    this.ngRenderer.setProperty(oLink, 'innerHTML', popupInfo['href'][hIdx]['label']); // Properties are DOM entities
                    this.ngRenderer.setAttribute(oLink, 'target', '_blank');
                    this.ngRenderer.appendChild(liElem, oLink);
                    this.ngRenderer.appendChild(this.popupBoxDiv, liElem);
                }
            }
        }
    }

    private openSidebarMenu(groupName: string, subGroup: string) {
        const menuChange: MenuChangeType = { group: groupName, subGroup: subGroup, state: MenuStateChangeType.OPENED };
        this.sidebarService.changeMenuState(menuChange);
    }

    private render() {
        this.renderer.render(this.scene, this.view.camera.camera3D);
    }

    private refresh() {
        this.view.notifyChange(true);
    }

}
