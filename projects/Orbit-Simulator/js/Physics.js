import CollisionMode from "./Enums/CollisionMode.js";
import InteractionMode from "./Enums/InteractionMode.js";

export default class Physics {
	// Simulation params
	interactMode = InteractionMode.All;
	timeSpeed = 1;
	g = 1;
	gravitMode = 0;
	collisionType = CollisionMode.Merge;
	
	collisionCeilSize = innerWidth; // Ceil collision algorithm ceil size
	
	constructor(scene) {
		// Set scene
		this.scene = scene;
	}
	
	// Init GPU.js
	initGPUjs(){
		this.gpu = new GPUJS();

		// Add functions to the GPU kernel
		function dist(x1, y1, x2, y2) { 
			return Math.sqrt((x1 - x2)*(x1 - x2) + (y1 - y2)*(y1 - y2));
		}
		
		this.gpu.addFunction(dist);
		this.gpu.addFunction(this.processGravity);
		
		// Compute function
		this.computeVelocities = this.gpu.createKernel(function(arr, len, timeSpeed, g, gravitMode) {
			const obj1Id = this.thread.x;
			const obj1Pos = [arr[obj1Id * this.constants.objLen], arr[obj1Id * this.constants.objLen + 1]];
			const obj1Vel = [0.0, 0.0];
			const obj1Mass = arr[obj1Id * this.constants.objLen + 2];
			const obj1Radius = arr[obj1Id * this.constants.objLen + 3]
			const obj1Lock = arr[obj1Id * this.constants.objLen + 4];

			for(let obj2Id = 0; obj2Id < len; obj2Id++){
				if (obj2Id !== obj1Id) {
					const obj2Pos = [arr[obj2Id * this.constants.objLen], arr[obj2Id * this.constants.objLen + 1]];
					const obj2Mass = arr[obj2Id * this.constants.objLen + 2];
					const obj2Radius = arr[obj2Id * this.constants.objLen + 3];

					const D = dist(obj1Pos[0],obj1Pos[1], obj2Pos[0],obj2Pos[1]);
					const sin = (obj2Pos[1] - obj1Pos[1])/D; // Sin
					const cos = (obj2Pos[0] - obj1Pos[0])/D; // Cos

					const gMod = D <= obj1Radius + obj2Radius ? 4 : gravitMode;

					const velocity = processGravity(sin, cos, D, gMod, obj2Mass, obj1Mass, timeSpeed, g);
					// Add calculated vectors to object 1
					if (obj1Lock === 0){
						obj1Vel[0] += velocity[0];
						obj1Vel[1] += velocity[1];	
					}
				}
			}

			return [obj1Vel[0], obj1Vel[1]];
		}, {dynamicOutput: true, dynamicArguments: true, constants: {objLen: 5}})
			.setLoopMaxIterations(1000000);
	}

	gpuComputeVelocities() {
		// Init GPU if not
		this.gpu || this.initGPUjs();

		const objArr = this.scene.objArr; // Objects array
		if (objArr.length > 1){
			this.beforePhysics();

			const prepairedArr = objArr.map(obj => [obj.x, obj.y, obj.m, obj.r, obj.lock]);
			this.computeVelocities.setOutput([objArr.length]);
			const newVelosities = this.computeVelocities(
				prepairedArr, 
				objArr.length, 
				this.timeSpeed, 
				this.g, 
				this.gravitMode
			);
			
			// After physics
			for (let obj1Id = objArr.length; obj1Id--;){
				const obj1 = objArr[obj1Id];
				obj1.vx += newVelosities[obj1Id][0];
				obj1.vy += newVelosities[obj1Id][1];
			}
			this.afterPhysics(this.timeSpeed);
		}
	}
	
	physicsCalculate() {
		const objArr = this.scene.objArr;
		// console.log('Calculate begin:');
		
		this.beforePhysics();

		// Physics calculating
		for (let objectId = objArr.length; objectId--;){
			this.calculate(objectId);
		}
		this.afterPhysics(this.timeSpeed);
	}

	// Runs before computing physics
	beforePhysics = () => {
		const data = {};
		const collidedPairs = this.collisionCeilAlgorithm();
		
		// Bounce collision
		if (ui.collisionMode.state === CollisionMode.Rebound) this.bounceCollision(collidedPairs);

		// Merge collision
		if (ui.collisionMode.state === CollisionMode.Merge) data.deletedObjectsData = this.mergeCollision(collidedPairs);

		// Bounce collision preprocessing
		if (ui.collisionMode.state === CollisionMode.Rebound) this.pullOutFromEachOther(collidedPairs);

		return data;
	}
	
	// Runs after finish computing physics
	afterPhysics = (timeSpeed) => {
		// Add velocities
		this.addVelocity(timeSpeed);
	}

	// Physics calculations
	calculate(objectId) {
		const objArr = this.scene.objArr;
		
		const interact = (obj1, obj2) => {
			if (obj2.lock === true && obj1.lock === true) return;
		
			const D = obj1.distance(obj2);
			const sin = (obj2.y - obj1.y)/D;
			const cos = (obj2.x - obj1.x)/D;
		
			let gravitMode = this.gravitMode;
			if (this.collisionType === CollisionMode.None){
				const radiusSum = obj1.r + obj2.r;
				if (D <= radiusSum) gravitMode = 4;
			}
			const vector = this.processGravity(sin, cos, D, gravitMode, obj2.m, obj1.m, this.timeSpeed, this.g);
			
			// Add calculated vectors to object 1
			obj1.vx += vector[0];
			obj1.vy += vector[1];
			
			// Add calculated vectors to object 2
			obj2.vx -= vector[2];
			obj2.vy -= vector[3];
		}
		
		const obj1 = objArr[objectId];
		if (this.interactMode === InteractionMode.All){
			for (let object2Id = objectId; object2Id--;){
				const obj2 = objArr[object2Id];

				interact(obj1, obj2);
			}
		} else
		if (this.interactMode === InteractionMode.Parent){
			const obj2 = objArr[obj1.parentObj];

			if (obj2 !== undefined) {
				interact(obj1, obj2);
			}
		}
	}

	// Функции притяжения
	// The reason why the function is named assigned as a property is because GPU.js requires this
	processGravity = function processGravity(sin, cos, D, gravitMode, mass1, mass2, timeSpeed, g) {
		let vx = 0.0, vy = 0.0;
		//Обратно-пропорционально квадрату расстояния
		if (gravitMode === 1){  // The gravitMode variable must be a number
			const kff = g * timeSpeed * 5;
			const pow2Distance = D*D;
			vx = kff*(cos/pow2Distance);
			vy = kff*(sin/pow2Distance);
		} else
		//Обранто-пропорционально кубу расстояния
		if (gravitMode === 0){
			const kff = g * timeSpeed * 500;
			const pow3Distance = D*D*D;
			vx = kff*(cos/pow3Distance);
			vy = kff*(sin/pow3Distance);
		} else
		//Обранто-пропорционально расстоянию
		if (gravitMode === 2){
			const kff = g * timeSpeed * 0.05;
			vx = kff*(cos/D);
			vy = kff*(sin/D);
		} else
		//Постоянное притяжение
		if (gravitMode === 3){
			const kff = g * timeSpeed * 0.00005;
			vx = kff*(cos);
			vy = kff*(sin);
		} else
		//Пропорционально расстоянию
		if (gravitMode === 4){
			const kff = g * timeSpeed * 0.0000005;
			vx = kff*(cos*D);
			vy = kff*(sin*D);
		}

		return [vx*mass1, vy*mass1, vx*mass2, vy*mass2];
	}
	
	makeObjPosMap(objArr = this.scene.objArr){
		const positionMatrix = new Map();
		const seilSize = this.collisionCeilSize;
		for (let objId = objArr.length; objId --;){
			let obj = objArr[objId];
			const posX = Math.floor(obj.x / seilSize);
			const posY = Math.floor(obj.y / seilSize);

			const mapX = positionMatrix.get(posX) || new Map();
			
			const arr = mapX.get(posY) || [];
			arr.push(objId);

			mapX.set(posY, arr);
			positionMatrix.set(posX, mapX);
		}
		return positionMatrix;
	}

	collisionCeilAlgorithm(){
		const objArr = this.scene.objArr;
		const collidedPairs = [];
		let posMap = this.makeObjPosMap();

		for (let [x, mapX] of posMap){
			for (let [y, iterObjs] of mapX) {
				const enumObjs = []; // Objects inside neighborhood ceils

				const cl1 = posMap.get(x + 1)?.get(y); // Right ceil
				const cl2 = posMap.get(x)?.get(y + 1); // Bottom ceil
				const cl3 = posMap.get(x + 1)?.get(y + 1); // Right bottom ceil
				const cl4 = posMap.get(x - 1)?.get(y + 1); // Left bottom ceil

				if (cl1) enumObjs.push(...cl1); // ░░░░░░
				if (cl2) enumObjs.push(...cl2); // ░░██▓▓
				if (cl3) enumObjs.push(...cl3); // ▓▓▓▓▓▓ 
				if (cl4) enumObjs.push(...cl4);

				// Iterate ceil for collision
				for (let i = iterObjs.length; i--;){
					const obj1Id = iterObjs[i];
					const obj1 = objArr[obj1Id];
					// Iterate neighborhood ceils
					for (let j = enumObjs.length; j--;){
						const obj2Id = enumObjs[j];
						const obj2 = objArr[obj2Id];
						
						if (obj1.intersects(obj2) !== null) {
							collidedPairs.push([obj1Id, obj2Id]);
						}
					}
					// Iterate current ceil
					for (let j = i; j--;){
						const obj2Id = iterObjs[j];
						const obj2 = objArr[obj2Id];
						
						if (obj1.intersects(obj2) !== null) {
							collidedPairs.push([obj1Id, obj2Id]);
						}
					}
				}
			}
		}
		return collidedPairs;
	}

	pullOutFromEachOther(collidedPairs = this.collisionCeilAlgorithm()){
		if ( !(ui.collisionMode.state == CollisionMode.Rebound && ui.interactMode.state == InteractionMode.All) ) {
			return;
		}
		
		const objArr = this.scene.objArr;
		const iterations = 1;
		for (let i = 0; i < iterations; i++){
			if (i > 0) collidedPairs = this.collisionCeilAlgorithm();
			
			for (let collidedPair of collidedPairs){
				const [object1Id, object2Id] = collidedPair;
				const obj1 = objArr[object1Id];
				const obj2 = objArr[object2Id];

				if (obj2.lock === true && obj1.lock === true) continue;

				const D = obj1.intersects(obj2);

				if (D === null) continue;
				
				let sin, cos;
				if (D > 0){ // Angle between objects
					cos = (obj2.x - obj1.x)/D;
					sin = (obj2.y - obj1.y)/D;
				} else { // Random angle
					const randAngleRadians = Math.random() * Math.PI * 2;
					cos = Math.cos(randAngleRadians);
					sin = Math.sin(randAngleRadians);
				}
				// Colliding
				const radiusSum = obj1.r + obj2.r;
				const mS = obj1.m + obj2.m; // Both objects mass sum
				const rD = radiusSum - D; // Total move
				const objAMov = obj1.lock ? 0 : obj2.lock ? rD : rD * (obj2.m / mS); // Object A move
				const objBMov = obj2.lock ? 0 : rD - objAMov; // Object B move
				obj1.x -= objAMov * cos; obj1.y -= objAMov * sin;
				obj2.x += objBMov * cos; obj2.y += objBMov * sin;
			}
		}
	}

	mergeCollision(collidedPairs){
		const objArr = this.scene.objArr;
		let deleteObjectList = [];
		
		for (let collidedPair of collidedPairs){
			let [obj1Id, obj2Id] = collidedPair;
			let [objA, objB] = [ objArr[obj1Id], objArr[obj2Id] ];
			if (deleteObjectList.includes(obj1Id) || deleteObjectList.includes(obj2Id))continue;
			if (objB.m + objA.m === 0){ // Anigilate
				deleteObjectList.push(obj1Id, obj2Id);
				if ( [obj1Id, obj2Id].includes(+camera.Target) && objArr === this.objArr ) camera.setTarget();
				continue;
			}

			let mixedColor = UtilityMethods.mixColors(objA.color, objB.color, objA.m, objB.m);

			let obj = objB, delObj = objA;
			let objToDelId = obj1Id;
			let alivedObjId = obj2Id;

			// Swap objects if
			if ((delObj.m > obj.m && objA.lock === objB.lock)
				|| (objA.lock !== objB.lock && objA.lock)
				|| (objA.m === objB.m && obj1Id < obj2Id)
			) {
				obj = objA; delObj = objB;
				objToDelId = obj2Id;
				alivedObjId = obj1Id;
			}
			// Center of mass point
			const movKff = obj.lock !== delObj.lock ? 0 : delObj.m / (objA.m + objB.m);
			obj.x += (delObj.x - obj.x) * movKff;
			obj.y += (delObj.y - obj.y) * movKff;
			// New velocity
			obj.vx = (objA.m*objA.vx+objB.m*objB.vx)/(objA.m+objB.m);// Формула абсолютно-неупругого столкновения
			obj.vy = (objA.m*objA.vy+objB.m*objB.vy)/(objA.m+objB.m);// Формула абсолютно-неупругого столкновения

			obj.m = objA.m + objB.m; // Set new mass to obj
			obj.updateRadius();
			obj.color = mixedColor;

			// Change camera target
			if (objArr === scene.objArr && objToDelId === camera.Target) camera.setTarget(alivedObjId);

			// Add obj to delete arreay
			deleteObjectList.push(objToDelId);
		}
		const deletedObjsArr = this.scene.deleteObject(deleteObjectList);
		return {
			idArr: deleteObjectList,
			objArr: deletedObjsArr
		}		
	}

	bounceCollision(collidedPairs){
		const objArr = this.scene.objArr;
		for (let collidedPair of collidedPairs) {
			const [obj1Id, obj2Id] = collidedPair;
			let [objA, objB] = [ objArr[obj1Id], objArr[obj2Id] ];

			let D = objA.distance(objB);
			
			let sin, cos;
			if (D > 0){ // Angle between objects
				cos = (objB.x - objA.x)/D;
				sin = (objB.y - objA.y)/D;
			} else { // Random angle
				const randAngleRadians = Math.random() * Math.PI * 2;
				cos = Math.cos(randAngleRadians);
				sin = Math.sin(randAngleRadians);
			}

			let v1 = UtilityMethods.gipot(objA.vx, objA.vy); // Scallar velocity
			let v2 = UtilityMethods.gipot(objB.vx, objB.vy); // Scallar velocity
			let vcos1 = v1 == 0?0:objA.vx/v1;
			let vsin1 = v1 == 0?0:objA.vy/v1;
			let vcos2 = v2 == 0?0:objB.vx/v2;
			let vsin2 = v2 == 0?0:objB.vy/v2;
			let ag1 = Math.atan2(vsin1, vcos1);
			let ag2 = Math.atan2(vsin2, vcos2);

			let fi = Math.atan2(sin, cos);
			
			// Object A new velocity
			if (!objA.lock){
				const m1 = objB.lock ? 0 : objA.m;
				const m2 = objB.m;
				objA.vx = (( v1*Math.cos(ag1 - fi)*(m1-m2) + 2*m2*v2*Math.cos(ag2 - fi) ) / (m2+m1) ) * Math.cos(fi) + v1*Math.sin(ag1 - fi)*Math.cos(fi+Math.PI/2);// Формула абсолютно-упругого столкновения
				objA.vy = (( v1*Math.cos(ag1 - fi)*(m1-m2) + 2*m2*v2*Math.cos(ag2 - fi) ) / (m2+m1) ) * Math.sin(fi) + v1*Math.sin(ag1 - fi)*Math.sin(fi+Math.PI/2);// Формула абсолютно-упругого столкновения
			}
			// Object B new velocity
			if (!objB.lock){
				const m1 = objA.m;
				const m2 = objA.lock ? 0 : objB.m;
				objB.vx = (( v2*Math.cos(ag2 - fi)*(m2-m1) + 2*m1*v1*Math.cos(ag1 - fi) ) / (m1+m2) ) * Math.cos(fi) + v2*Math.sin(ag2 - fi)*Math.cos(fi+Math.PI/2);// Формула абсолютно-упругого столкновения
				objB.vy = (( v2*Math.cos(ag2 - fi)*(m2-m1) + 2*m1*v1*Math.cos(ag1 - fi) ) / (m1+m2) ) * Math.sin(fi) + v2*Math.sin(ag2 - fi)*Math.sin(fi+Math.PI/2);// Формула абсолютно-упругого столкновения
			}

			// Elasticity
			const elasticity = ui.collisionElasticity.value;
			const centerOfMass = this.scene.getCenterOfMass([objA, objB]);

			objA.vx = (objA.vx - centerOfMass.vx) * elasticity + centerOfMass.vx;
			objA.vy = (objA.vy - centerOfMass.vy) * elasticity + centerOfMass.vy;

			objB.vx = (objB.vx - centerOfMass.vx) * elasticity + centerOfMass.vx;
			objB.vy = (objB.vy - centerOfMass.vy) * elasticity + centerOfMass.vy;
		}
		// Add new velocities
		const timeSpeed = ui.timeSpeed.state;
		const applyBounceVelocity = (obj, objBLock, centerOfMass) => {
			if (obj.lock) return;

			if (objBLock) {
				obj.x += obj.vx * timeSpeed;
				obj.y += obj.vy * timeSpeed;
			} else {
				obj.x -= centerOfMass.vx * timeSpeed;
				obj.y -= centerOfMass.vy * timeSpeed;
				
				obj.x += obj.vx * timeSpeed;
				obj.y += obj.vy * timeSpeed;
			}
		}
		for (let collidedPair of collidedPairs) {
			const [obj1Id, obj2Id] = collidedPair;
			let [objA, objB] = [ objArr[obj1Id], objArr[obj2Id] ];

			const centerOfMass = this.scene.getCenterOfMass([objA, objB]);
			applyBounceVelocity(objA, objB.lock, centerOfMass);
			applyBounceVelocity(objB, objA.lock, centerOfMass);
		}
	}
	// Add objects vectors to objects
	addVelocity(timeSpeed){
		const objArr = this.scene.objArr;
		// Add the vectors
		for (let objId = objArr.length; objId--;){
			let object = objArr[objId];

			// Object moving
			if (mov_obj === objId){
				object.vx = object.vy = 0;
				continue;	
			}

			// Add vectors
			if (object.lock){
				object.vx = object.vy = 0;
			} else {
				object.x += object.vx * timeSpeed;
				object.y += object.vy * timeSpeed;
				object.vx *= ui.movementResistance.getResistance(timeSpeed);
				object.vy *= ui.movementResistance.getResistance(timeSpeed);

				if (ui.interactMode.state === InteractionMode.Parent){
					let mainObj = objArr[object.parentObj];
					while(mainObj != undefined){
						object.x += mainObj.vx * timeSpeed;
						object.y += mainObj.vy * timeSpeed;
						mainObj = objArr[mainObj.parentObj];
					}
				}
				// Allow frame render if object moves
				if (object.vx || object.vy) renderer.allowFrameRender = true;
			}
		}
	}
}
