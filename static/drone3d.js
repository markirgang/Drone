/**
 * 3D Quadcopter Drone Renderer using Three.js
 * Renders a Pixhawk 4 Quadcopter Drone with spinning propellers, LED status lights, flight shadow, and trajectory trail.
 */

class Drone3DRenderer {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        if (!this.container) return;

        this.scene = new THREE.Scene();
        this.scene.background = new THREE.Color(0x060913);
        this.scene.fog = new THREE.FogExp2(0x060913, 0.015);

        this.camera = new THREE.PerspectiveCamera(50, this.container.clientWidth / this.container.clientHeight, 0.1, 1000);
        this.camera.position.set(0, 3.5, 6);

        this.renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        this.container.appendChild(this.renderer.domElement);

        this.controls = new THREE.OrbitControls(this.camera, this.renderer.domElement);
        this.controls.enableDamping = true;
        this.controls.dampingFactor = 0.05;
        this.controls.maxPolarAngle = Math.PI / 2 + 0.1;

        this.propellers = [];
        this.armLeds = [];
        this.flightTrailPoints = [];
        this.trailLine = null;

        this.initLighting();
        this.initEnvironment();
        this.buildDroneModel();
        this.initFlightTrail();

        window.addEventListener('resize', () => this.onWindowResize());
        this.animate();
    }

    initLighting() {
        const ambientLight = new THREE.AmbientLight(0xffffff, 0.7);
        this.scene.add(ambientLight);

        const dirLight = new THREE.DirectionalLight(0xffffff, 1.2);
        dirLight.position.set(10, 20, 10);
        dirLight.castShadow = true;
        dirLight.shadow.mapSize.width = 2048;
        dirLight.shadow.mapSize.height = 2048;
        dirLight.shadow.camera.near = 0.5;
        dirLight.shadow.camera.far = 50;
        dirLight.shadow.camera.left = -10;
        dirLight.shadow.camera.right = 10;
        dirLight.shadow.camera.top = 10;
        dirLight.shadow.camera.bottom = -10;
        this.scene.add(dirLight);

        const cyanLight = new THREE.PointLight(0x00f0ff, 1.5, 10);
        cyanLight.position.set(0, 2, 0);
        this.scene.add(cyanLight);
    }

    initEnvironment() {
        // Ground Grid
        const gridHelper = new THREE.GridHelper(50, 50, 0x00f0ff, 0x1e293b);
        gridHelper.position.y = 0;
        this.scene.add(gridHelper);

        // Ground Plane for Shadows
        const planeGeo = new THREE.PlaneGeometry(100, 100);
        const planeMat = new THREE.ShadowMaterial({ opacity: 0.4 });
        const shadowPlane = new THREE.Mesh(planeGeo, planeMat);
        shadowPlane.rotation.x = -Math.PI / 2;
        shadowPlane.receiveShadow = true;
        this.scene.add(shadowPlane);
    }

    buildDroneModel() {
        this.droneGroup = new THREE.Group();

        // 1. Central Body Frame
        const bodyGeo = new THREE.BoxGeometry(0.8, 0.22, 0.8);
        const carbonMat = new THREE.MeshStandardMaterial({
            color: 0x1e293b,
            roughness: 0.3,
            metalness: 0.8
        });
        const bodyMesh = new THREE.Mesh(bodyGeo, carbonMat);
        bodyMesh.castShadow = true;
        this.droneGroup.add(bodyMesh);

        // Top Canopy Dome
        const canopyGeo = new THREE.SphereGeometry(0.32, 16, 12, 0, Math.PI * 2, 0, Math.PI / 2);
        const canopyMat = new THREE.MeshStandardMaterial({
            color: 0x0f172a,
            roughness: 0.2,
            metalness: 0.9
        });
        const canopyMesh = new THREE.Mesh(canopyGeo, canopyMat);
        canopyMesh.position.y = 0.11;
        canopyMesh.castShadow = true;
        this.droneGroup.add(canopyMesh);

        // Pixhawk Logo Plate
        const logoGeo = new THREE.BoxGeometry(0.25, 0.04, 0.25);
        const logoMat = new THREE.MeshStandardMaterial({ color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 0.5 });
        const logoMesh = new THREE.Mesh(logoGeo, logoMat);
        logoMesh.position.y = 0.32;
        this.droneGroup.add(logoMesh);

        // 2. eMeet Pixy Camera Mount (Front)
        const camMountGroup = new THREE.Group();
        camMountGroup.position.set(0, 0, -0.45);

        const camBodyGeo = new THREE.CylinderGeometry(0.12, 0.12, 0.25, 16);
        const camMat = new THREE.MeshStandardMaterial({ color: 0x334155, metalness: 0.8 });
        const camMesh = new THREE.Mesh(camBodyGeo, camMat);
        camMesh.rotation.x = Math.PI / 2;
        camMountGroup.add(camMesh);

        const lensGeo = new THREE.CylinderGeometry(0.07, 0.07, 0.06, 16);
        const lensMat = new THREE.MeshStandardMaterial({ color: 0x00f0ff, emissive: 0x00f0ff, emissiveIntensity: 0.8 });
        const lensMesh = new THREE.Mesh(lensGeo, lensMat);
        lensMesh.rotation.x = Math.PI / 2;
        lensMesh.position.z = -0.13;
        camMountGroup.add(lensMesh);

        this.droneGroup.add(camMountGroup);

        // 3. Four Motor Arms in X Layout (Front-Left, Front-Right, Rear-Left, Rear-Right)
        const armPositions = [
            { x:  0.8, z: -0.8, angle:  Math.PI / 4, color: 0x10b981 }, // Front Right (Green LED)
            { x: -0.8, z: -0.8, angle: -Math.PI / 4, color: 0x10b981 }, // Front Left (Green LED)
            { x:  0.8, z:  0.8, angle:  3 * Math.PI / 4, color: 0xef4444 }, // Rear Right (Red LED)
            { x: -0.8, z:  0.8, angle: -3 * Math.PI / 4, color: 0xef4444 }  // Rear Left (Red LED)
        ];

        armPositions.forEach((pos, idx) => {
            const armGroup = new THREE.Group();

            // Arm Rod
            const armGeo = new THREE.BoxGeometry(0.12, 0.08, 1.1);
            const armMesh = new THREE.Mesh(armGeo, carbonMat);
            armMesh.position.set(pos.x / 2, 0, pos.z / 2);
            armMesh.rotation.y = pos.angle;
            armMesh.castShadow = true;
            this.droneGroup.add(armMesh);

            // Motor Pod
            const motorGeo = new THREE.CylinderGeometry(0.15, 0.15, 0.22, 16);
            const motorMat = new THREE.MeshStandardMaterial({ color: 0x0f172a, metalness: 0.9, roughness: 0.2 });
            const motorMesh = new THREE.Mesh(motorGeo, motorMat);
            motorMesh.position.set(pos.x, 0.1, pos.z);
            motorMesh.castShadow = true;
            this.droneGroup.add(motorMesh);

            // LED Ring Indicator
            const ledGeo = new THREE.SphereGeometry(0.06, 8, 8);
            const ledMat = new THREE.MeshStandardMaterial({ color: pos.color, emissive: pos.color, emissiveIntensity: 0.9 });
            const ledMesh = new THREE.Mesh(ledGeo, ledMat);
            ledMesh.position.set(pos.x, -0.08, pos.z);
            this.droneGroup.add(ledMesh);
            this.armLeds.push(ledMat);

            // Propeller
            const propGroup = new THREE.Group();
            propGroup.position.set(pos.x, 0.23, pos.z);

            const propBladeGeo = new THREE.BoxGeometry(1.2, 0.02, 0.12);
            const propMat = new THREE.MeshStandardMaterial({
                color: idx < 2 ? 0x00f0ff : 0x334155,
                roughness: 0.4,
                transparent: true,
                opacity: 0.9
            });
            const propMesh = new THREE.Mesh(propBladeGeo, propMat);
            propMesh.castShadow = true;
            propGroup.add(propMesh);

            // Spinner Cap
            const capGeo = new THREE.ConeGeometry(0.08, 0.12, 12);
            const capMat = new THREE.MeshStandardMaterial({ color: 0x1e293b });
            const capMesh = new THREE.Mesh(capGeo, capMat);
            capMesh.position.y = 0.06;
            propGroup.add(capMesh);

            this.droneGroup.add(propGroup);
            this.propellers.push(propGroup);
        });

        // 4. Landing Gear Legs
        const legMat = new THREE.MeshStandardMaterial({ color: 0x1e293b, metalness: 0.8 });
        [-0.4, 0.4].forEach(x => {
            const legGeo = new THREE.BoxGeometry(0.06, 0.4, 0.06);
            const legMesh = new THREE.Mesh(legGeo, legMat);
            legMesh.position.set(x, -0.25, 0);
            legMesh.castShadow = true;
            this.droneGroup.add(legMesh);

            const footGeo = new THREE.BoxGeometry(0.12, 0.05, 0.9);
            const footMesh = new THREE.Mesh(footGeo, legMat);
            footMesh.position.set(x, -0.42, 0);
            footMesh.castShadow = true;
            this.droneGroup.add(footMesh);
        });

        // Lift drone slightly so feet rest on ground
        this.droneGroup.position.y = 0.45;
        this.scene.add(this.droneGroup);
    }

    initFlightTrail() {
        const trailMat = new THREE.LineBasicMaterial({
            color: 0x00f0ff,
            linewidth: 2,
            transparent: true,
            opacity: 0.8
        });
        const trailGeo = new THREE.BufferGeometry();
        this.trailLine = new THREE.Line(trailGeo, trailMat);
        this.scene.add(this.trailLine);
    }

    updatePose(pitchDeg, rollDeg, yawDeg, altitudeMeters, isArmed) {
        if (!this.droneGroup) return;

        // Altitude Y Position
        const targetY = 0.45 + (altitudeMeters * 1.5);
        this.droneGroup.position.y += (targetY - this.droneGroup.position.y) * 0.15;

        // Rotation
        const radRoll = THREE.MathUtils.degToRad(rollDeg);
        const radPitch = THREE.MathUtils.degToRad(pitchDeg);
        const radYaw = THREE.MathUtils.degToRad(yawDeg);

        this.droneGroup.rotation.x = radPitch;
        this.droneGroup.rotation.z = -radRoll;
        this.droneGroup.rotation.y = radYaw;

        // Spin Propellers if Armed or Flying
        if (isArmed || altitudeMeters > 0.05) {
            const speed = 0.4 + (altitudeMeters > 0.1 ? 0.3 : 0.0);
            this.propellers.forEach((prop, i) => {
                const dir = (i % 2 === 0) ? 1 : -1;
                prop.rotation.y += speed * dir;
            });

            this.armLeds.forEach(led => {
                led.emissiveIntensity = 0.7 + Math.sin(Date.now() * 0.01) * 0.3;
            });
        } else {
            this.armLeds.forEach(led => {
                led.emissiveIntensity = 0.3;
            });
        }

        // Update Flight Trail
        if (altitudeMeters > 0.1) {
            this.flightTrailPoints.push(this.droneGroup.position.clone());
            if (this.flightTrailPoints.length > 120) {
                this.flightTrailPoints.shift();
            }
            const positions = new Float32Array(this.flightTrailPoints.length * 3);
            this.flightTrailPoints.forEach((p, idx) => {
                positions[idx * 3] = p.x;
                positions[idx * 3 + 1] = p.y;
                positions[idx * 3 + 2] = p.z;
            });
            this.trailLine.geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
            this.trailLine.geometry.needsUpdate = true;
        }
    }

    setCameraPreset(type) {
        if (type === 'top') {
            this.camera.position.set(0, 10, 0.1);
            this.controls.target.set(0, this.droneGroup.position.y, 0);
        } else if (type === 'chaser') {
            this.camera.position.set(0, this.droneGroup.position.y + 1.2, this.droneGroup.position.z + 4);
            this.controls.target.copy(this.droneGroup.position);
        } else {
            this.camera.position.set(0, 3.5, 6);
            this.controls.target.set(0, 0.8, 0);
        }
        this.controls.update();
    }

    onWindowResize() {
        if (!this.container) return;
        this.camera.aspect = this.container.clientWidth / this.container.clientHeight;
        this.camera.updateProjectionMatrix();
        this.renderer.setSize(this.container.clientWidth, this.container.clientHeight);
    }

    animate() {
        requestAnimationFrame(() => this.animate());
        this.controls.update();
        this.renderer.render(this.scene, this.camera);
    }
}
