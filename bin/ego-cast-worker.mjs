#!/usr/bin/env node
import { createRequire } from "node:module";
import { createServer } from "node:http";
import { constants, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { access } from "node:fs/promises";
import { promisify } from "node:util";

//#region rolldown:runtime
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __commonJS = (cb, mod) => function() {
	return mod || (0, cb[__getOwnPropNames(cb)[0]])((mod = { exports: {} }).exports, mod), mod.exports;
};
var __copyProps = (to, from, except, desc) => {
	if (from && typeof from === "object" || typeof from === "function") for (var keys = __getOwnPropNames(from), i = 0, n = keys.length, key; i < n; i++) {
		key = keys[i];
		if (!__hasOwnProp.call(to, key) && key !== except) __defProp(to, key, {
			get: ((k) => from[k]).bind(null, key),
			enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable
		});
	}
	return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", {
	value: mod,
	enumerable: true
}) : target, mod));
var __require = /* @__PURE__ */ createRequire(import.meta.url);

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js
var require_constants = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/constants.js": ((exports, module) => {
	const BINARY_TYPES$2 = [
		"nodebuffer",
		"arraybuffer",
		"fragments"
	];
	const hasBlob$1 = typeof Blob !== "undefined";
	if (hasBlob$1) BINARY_TYPES$2.push("blob");
	module.exports = {
		BINARY_TYPES: BINARY_TYPES$2,
		CLOSE_TIMEOUT: 3e4,
		EMPTY_BUFFER: Buffer.alloc(0),
		GUID: "258EAFA5-E914-47DA-95CA-C5AB0DC85B11",
		hasBlob: hasBlob$1,
		kForOnEventAttribute: Symbol("kIsForOnEventAttribute"),
		kListener: Symbol("kListener"),
		kStatusCode: Symbol("status-code"),
		kWebSocket: Symbol("websocket"),
		NOOP: () => {}
	};
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/buffer-util.js
var require_buffer_util = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/buffer-util.js": ((exports, module) => {
	const { EMPTY_BUFFER: EMPTY_BUFFER$3 } = require_constants();
	const FastBuffer$2 = Buffer[Symbol.species];
	/**
	* Merges an array of buffers into a new buffer.
	*
	* @param {Buffer[]} list The array of buffers to concat
	* @param {Number} totalLength The total length of buffers in the list
	* @return {Buffer} The resulting buffer
	* @public
	*/
	function concat$1(list, totalLength) {
		if (list.length === 0) return EMPTY_BUFFER$3;
		if (list.length === 1) return list[0];
		const target = Buffer.allocUnsafe(totalLength);
		let offset = 0;
		for (let i = 0; i < list.length; i++) {
			const buf = list[i];
			target.set(buf, offset);
			offset += buf.length;
		}
		if (offset < totalLength) return new FastBuffer$2(target.buffer, target.byteOffset, offset);
		return target;
	}
	/**
	* Masks a buffer using the given mask.
	*
	* @param {Buffer} source The buffer to mask
	* @param {Buffer} mask The mask to use
	* @param {Buffer} output The buffer where to store the result
	* @param {Number} offset The offset at which to start writing
	* @param {Number} length The number of bytes to mask.
	* @public
	*/
	function _mask(source, mask, output, offset, length) {
		for (let i = 0; i < length; i++) output[offset + i] = source[i] ^ mask[i & 3];
	}
	/**
	* Unmasks a buffer using the given mask.
	*
	* @param {Buffer} buffer The buffer to unmask
	* @param {Buffer} mask The mask to use
	* @public
	*/
	function _unmask(buffer, mask) {
		for (let i = 0; i < buffer.length; i++) buffer[i] ^= mask[i & 3];
	}
	/**
	* Converts a buffer to an `ArrayBuffer`.
	*
	* @param {Buffer} buf The buffer to convert
	* @return {ArrayBuffer} Converted buffer
	* @public
	*/
	function toArrayBuffer$1(buf) {
		if (buf.length === buf.buffer.byteLength) return buf.buffer;
		return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length);
	}
	/**
	* Converts `data` to a `Buffer`.
	*
	* @param {*} data The data to convert
	* @return {Buffer} The buffer
	* @throws {TypeError}
	* @public
	*/
	function toBuffer$2(data) {
		toBuffer$2.readOnly = true;
		if (Buffer.isBuffer(data)) return data;
		let buf;
		if (data instanceof ArrayBuffer) buf = new FastBuffer$2(data);
		else if (ArrayBuffer.isView(data)) buf = new FastBuffer$2(data.buffer, data.byteOffset, data.byteLength);
		else {
			buf = Buffer.from(data);
			toBuffer$2.readOnly = false;
		}
		return buf;
	}
	module.exports = {
		concat: concat$1,
		mask: _mask,
		toArrayBuffer: toArrayBuffer$1,
		toBuffer: toBuffer$2,
		unmask: _unmask
	};
	/* istanbul ignore else  */
	if (!process.env.WS_NO_BUFFER_UTIL) try {
		const bufferUtil$1 = __require("bufferutil");
		module.exports.mask = function(source, mask, output, offset, length) {
			if (length < 48) _mask(source, mask, output, offset, length);
			else bufferUtil$1.mask(source, mask, output, offset, length);
		};
		module.exports.unmask = function(buffer, mask) {
			if (buffer.length < 32) _unmask(buffer, mask);
			else bufferUtil$1.unmask(buffer, mask);
		};
	} catch (e) {}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/limiter.js
var require_limiter = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/limiter.js": ((exports, module) => {
	const kDone = Symbol("kDone");
	const kRun = Symbol("kRun");
	/**
	* A very simple job queue with adjustable concurrency. Adapted from
	* https://github.com/STRML/async-limiter
	*/
	var Limiter$1 = class {
		/**
		* Creates a new `Limiter`.
		*
		* @param {Number} [concurrency=Infinity] The maximum number of jobs allowed
		*     to run concurrently
		*/
		constructor(concurrency) {
			this[kDone] = () => {
				this.pending--;
				this[kRun]();
			};
			this.concurrency = concurrency || Infinity;
			this.jobs = [];
			this.pending = 0;
		}
		/**
		* Adds a job to the queue.
		*
		* @param {Function} job The job to run
		* @public
		*/
		add(job) {
			this.jobs.push(job);
			this[kRun]();
		}
		/**
		* Removes a job from the queue and runs it if possible.
		*
		* @private
		*/
		[kRun]() {
			if (this.pending === this.concurrency) return;
			if (this.jobs.length) {
				const job = this.jobs.shift();
				this.pending++;
				job(this[kDone]);
			}
		}
	};
	module.exports = Limiter$1;
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/permessage-deflate.js
var require_permessage_deflate = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/permessage-deflate.js": ((exports, module) => {
	const zlib = __require("zlib");
	const bufferUtil = require_buffer_util();
	const Limiter = require_limiter();
	const { kStatusCode: kStatusCode$2 } = require_constants();
	const FastBuffer$1 = Buffer[Symbol.species];
	const TRAILER = Buffer.from([
		0,
		0,
		255,
		255
	]);
	const kPerMessageDeflate = Symbol("permessage-deflate");
	const kTotalLength = Symbol("total-length");
	const kCallback = Symbol("callback");
	const kBuffers = Symbol("buffers");
	const kError$1 = Symbol("error");
	let zlibLimiter;
	/**
	* permessage-deflate implementation.
	*/
	var PerMessageDeflate$5 = class {
		/**
		* Creates a PerMessageDeflate instance.
		*
		* @param {Object} [options] Configuration options
		* @param {(Boolean|Number)} [options.clientMaxWindowBits] Advertise support
		*     for, or request, a custom client window size
		* @param {Boolean} [options.clientNoContextTakeover=false] Advertise/
		*     acknowledge disabling of client context takeover
		* @param {Number} [options.concurrencyLimit=10] The number of concurrent
		*     calls to zlib
		* @param {Boolean} [options.isServer=false] Create the instance in either
		*     server or client mode
		* @param {Number} [options.maxPayload=0] The maximum allowed message length
		* @param {(Boolean|Number)} [options.serverMaxWindowBits] Request/confirm the
		*     use of a custom server window size
		* @param {Boolean} [options.serverNoContextTakeover=false] Request/accept
		*     disabling of server context takeover
		* @param {Number} [options.threshold=1024] Size (in bytes) below which
		*     messages should not be compressed if context takeover is disabled
		* @param {Object} [options.zlibDeflateOptions] Options to pass to zlib on
		*     deflate
		* @param {Object} [options.zlibInflateOptions] Options to pass to zlib on
		*     inflate
		*/
		constructor(options) {
			this._options = options || {};
			this._threshold = this._options.threshold !== void 0 ? this._options.threshold : 1024;
			this._maxPayload = this._options.maxPayload | 0;
			this._isServer = !!this._options.isServer;
			this._deflate = null;
			this._inflate = null;
			this.params = null;
			if (!zlibLimiter) zlibLimiter = new Limiter(this._options.concurrencyLimit !== void 0 ? this._options.concurrencyLimit : 10);
		}
		/**
		* @type {String}
		*/
		static get extensionName() {
			return "permessage-deflate";
		}
		/**
		* Create an extension negotiation offer.
		*
		* @return {Object} Extension parameters
		* @public
		*/
		offer() {
			const params = {};
			if (this._options.serverNoContextTakeover) params.server_no_context_takeover = true;
			if (this._options.clientNoContextTakeover) params.client_no_context_takeover = true;
			if (this._options.serverMaxWindowBits) params.server_max_window_bits = this._options.serverMaxWindowBits;
			if (this._options.clientMaxWindowBits) params.client_max_window_bits = this._options.clientMaxWindowBits;
			else if (this._options.clientMaxWindowBits == null) params.client_max_window_bits = true;
			return params;
		}
		/**
		* Accept an extension negotiation offer/response.
		*
		* @param {Array} configurations The extension negotiation offers/reponse
		* @return {Object} Accepted configuration
		* @public
		*/
		accept(configurations) {
			configurations = this.normalizeParams(configurations);
			this.params = this._isServer ? this.acceptAsServer(configurations) : this.acceptAsClient(configurations);
			return this.params;
		}
		/**
		* Releases all resources used by the extension.
		*
		* @public
		*/
		cleanup() {
			if (this._inflate) {
				this._inflate.close();
				this._inflate = null;
			}
			if (this._deflate) {
				const callback = this._deflate[kCallback];
				this._deflate.close();
				this._deflate = null;
				if (callback) callback(/* @__PURE__ */ new Error("The deflate stream was closed while data was being processed"));
			}
		}
		/**
		*  Accept an extension negotiation offer.
		*
		* @param {Array} offers The extension negotiation offers
		* @return {Object} Accepted configuration
		* @private
		*/
		acceptAsServer(offers) {
			const opts = this._options;
			const accepted = offers.find((params) => {
				if (opts.serverNoContextTakeover === false && params.server_no_context_takeover || params.server_max_window_bits && (opts.serverMaxWindowBits === false || typeof opts.serverMaxWindowBits === "number" && opts.serverMaxWindowBits > params.server_max_window_bits) || typeof opts.clientMaxWindowBits === "number" && (typeof params.client_max_window_bits === "number" ? opts.clientMaxWindowBits > params.client_max_window_bits : !params.client_max_window_bits)) return false;
				return true;
			});
			if (!accepted) throw new Error("None of the extension offers can be accepted");
			if (opts.serverNoContextTakeover) accepted.server_no_context_takeover = true;
			if (opts.clientNoContextTakeover) accepted.client_no_context_takeover = true;
			if (typeof opts.serverMaxWindowBits === "number") accepted.server_max_window_bits = opts.serverMaxWindowBits;
			if (typeof opts.clientMaxWindowBits === "number") accepted.client_max_window_bits = opts.clientMaxWindowBits;
			else if (accepted.client_max_window_bits === true || opts.clientMaxWindowBits === false) delete accepted.client_max_window_bits;
			return accepted;
		}
		/**
		* Accept the extension negotiation response.
		*
		* @param {Array} response The extension negotiation response
		* @return {Object} Accepted configuration
		* @private
		*/
		acceptAsClient(response) {
			const params = response[0];
			if (this._options.clientNoContextTakeover === false && params.client_no_context_takeover) throw new Error("Unexpected parameter \"client_no_context_takeover\"");
			if (!params.client_max_window_bits) {
				if (typeof this._options.clientMaxWindowBits === "number") params.client_max_window_bits = this._options.clientMaxWindowBits;
			} else if (this._options.clientMaxWindowBits === false || typeof this._options.clientMaxWindowBits === "number" && params.client_max_window_bits > this._options.clientMaxWindowBits) throw new Error("Unexpected or invalid parameter \"client_max_window_bits\"");
			return params;
		}
		/**
		* Normalize parameters.
		*
		* @param {Array} configurations The extension negotiation offers/reponse
		* @return {Array} The offers/response with normalized parameters
		* @private
		*/
		normalizeParams(configurations) {
			configurations.forEach((params) => {
				Object.keys(params).forEach((key) => {
					let value = params[key];
					if (value.length > 1) throw new Error(`Parameter "${key}" must have only a single value`);
					value = value[0];
					if (key === "client_max_window_bits") {
						if (value !== true) {
							const num = +value;
							if (!Number.isInteger(num) || num < 8 || num > 15) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
							value = num;
						} else if (!this._isServer) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
					} else if (key === "server_max_window_bits") {
						const num = +value;
						if (!Number.isInteger(num) || num < 8 || num > 15) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
						value = num;
					} else if (key === "client_no_context_takeover" || key === "server_no_context_takeover") {
						if (value !== true) throw new TypeError(`Invalid value for parameter "${key}": ${value}`);
					} else throw new Error(`Unknown parameter "${key}"`);
					params[key] = value;
				});
			});
			return configurations;
		}
		/**
		* Decompress data. Concurrency limited.
		*
		* @param {Buffer} data Compressed data
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @public
		*/
		decompress(data, fin, callback) {
			zlibLimiter.add((done) => {
				this._decompress(data, fin, (err, result) => {
					done();
					callback(err, result);
				});
			});
		}
		/**
		* Compress data. Concurrency limited.
		*
		* @param {(Buffer|String)} data Data to compress
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @public
		*/
		compress(data, fin, callback) {
			zlibLimiter.add((done) => {
				this._compress(data, fin, (err, result) => {
					done();
					callback(err, result);
				});
			});
		}
		/**
		* Decompress data.
		*
		* @param {Buffer} data Compressed data
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @private
		*/
		_decompress(data, fin, callback) {
			const endpoint = this._isServer ? "client" : "server";
			if (!this._inflate) {
				const key = `${endpoint}_max_window_bits`;
				const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
				this._inflate = zlib.createInflateRaw({
					...this._options.zlibInflateOptions,
					windowBits
				});
				this._inflate[kPerMessageDeflate] = this;
				this._inflate[kTotalLength] = 0;
				this._inflate[kBuffers] = [];
				this._inflate.on("error", inflateOnError);
				this._inflate.on("data", inflateOnData);
			}
			this._inflate[kCallback] = callback;
			this._inflate.write(data);
			if (fin) this._inflate.write(TRAILER);
			this._inflate.flush(() => {
				const err = this._inflate[kError$1];
				if (err) {
					this._inflate.close();
					this._inflate = null;
					callback(err);
					return;
				}
				const data$1 = bufferUtil.concat(this._inflate[kBuffers], this._inflate[kTotalLength]);
				if (this._inflate._readableState.endEmitted) {
					this._inflate.close();
					this._inflate = null;
				} else {
					this._inflate[kTotalLength] = 0;
					this._inflate[kBuffers] = [];
					if (fin && this.params[`${endpoint}_no_context_takeover`]) this._inflate.reset();
				}
				callback(null, data$1);
			});
		}
		/**
		* Compress data.
		*
		* @param {(Buffer|String)} data Data to compress
		* @param {Boolean} fin Specifies whether or not this is the last fragment
		* @param {Function} callback Callback
		* @private
		*/
		_compress(data, fin, callback) {
			const endpoint = this._isServer ? "server" : "client";
			if (!this._deflate) {
				const key = `${endpoint}_max_window_bits`;
				const windowBits = typeof this.params[key] !== "number" ? zlib.Z_DEFAULT_WINDOWBITS : this.params[key];
				this._deflate = zlib.createDeflateRaw({
					...this._options.zlibDeflateOptions,
					windowBits
				});
				this._deflate[kTotalLength] = 0;
				this._deflate[kBuffers] = [];
				this._deflate.on("data", deflateOnData);
			}
			this._deflate[kCallback] = callback;
			this._deflate.write(data);
			this._deflate.flush(zlib.Z_SYNC_FLUSH, () => {
				if (!this._deflate) return;
				let data$1 = bufferUtil.concat(this._deflate[kBuffers], this._deflate[kTotalLength]);
				if (fin) data$1 = new FastBuffer$1(data$1.buffer, data$1.byteOffset, data$1.length - 4);
				this._deflate[kCallback] = null;
				this._deflate[kTotalLength] = 0;
				this._deflate[kBuffers] = [];
				if (fin && this.params[`${endpoint}_no_context_takeover`]) this._deflate.reset();
				callback(null, data$1);
			});
		}
	};
	module.exports = PerMessageDeflate$5;
	/**
	* The listener of the `zlib.DeflateRaw` stream `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function deflateOnData(chunk) {
		this[kBuffers].push(chunk);
		this[kTotalLength] += chunk.length;
	}
	/**
	* The listener of the `zlib.InflateRaw` stream `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function inflateOnData(chunk) {
		this[kTotalLength] += chunk.length;
		if (this[kPerMessageDeflate]._maxPayload < 1 || this[kTotalLength] <= this[kPerMessageDeflate]._maxPayload) {
			this[kBuffers].push(chunk);
			return;
		}
		this[kError$1] = /* @__PURE__ */ new RangeError("Max payload size exceeded");
		this[kError$1].code = "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH";
		this[kError$1][kStatusCode$2] = 1009;
		this.removeListener("data", inflateOnData);
		this.reset();
	}
	/**
	* The listener of the `zlib.InflateRaw` stream `'error'` event.
	*
	* @param {Error} err The emitted error
	* @private
	*/
	function inflateOnError(err) {
		this[kPerMessageDeflate]._inflate = null;
		if (this[kError$1]) {
			this[kCallback](this[kError$1]);
			return;
		}
		err[kStatusCode$2] = 1007;
		this[kCallback](err);
	}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/validation.js
var require_validation = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/validation.js": ((exports, module) => {
	const { isUtf8 } = __require("buffer");
	const { hasBlob } = require_constants();
	const tokenChars$2 = [
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		0,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		1,
		1,
		0,
		1,
		1,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0,
		0,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		0,
		0,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		1,
		0,
		1,
		0,
		1,
		0
	];
	/**
	* Checks if a status code is allowed in a close frame.
	*
	* @param {Number} code The status code
	* @return {Boolean} `true` if the status code is valid, else `false`
	* @public
	*/
	function isValidStatusCode$2(code) {
		return code >= 1e3 && code <= 1014 && code !== 1004 && code !== 1005 && code !== 1006 || code >= 3e3 && code <= 4999;
	}
	/**
	* Checks if a given buffer contains only correct UTF-8.
	* Ported from https://www.cl.cam.ac.uk/%7Emgk25/ucs/utf8_check.c by
	* Markus Kuhn.
	*
	* @param {Buffer} buf The buffer to check
	* @return {Boolean} `true` if `buf` contains only correct UTF-8, else `false`
	* @public
	*/
	function _isValidUTF8(buf) {
		const len = buf.length;
		let i = 0;
		while (i < len) if ((buf[i] & 128) === 0) i++;
		else if ((buf[i] & 224) === 192) {
			if (i + 1 === len || (buf[i + 1] & 192) !== 128 || (buf[i] & 254) === 192) return false;
			i += 2;
		} else if ((buf[i] & 240) === 224) {
			if (i + 2 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || buf[i] === 224 && (buf[i + 1] & 224) === 128 || buf[i] === 237 && (buf[i + 1] & 224) === 160) return false;
			i += 3;
		} else if ((buf[i] & 248) === 240) {
			if (i + 3 >= len || (buf[i + 1] & 192) !== 128 || (buf[i + 2] & 192) !== 128 || (buf[i + 3] & 192) !== 128 || buf[i] === 240 && (buf[i + 1] & 240) === 128 || buf[i] === 244 && buf[i + 1] > 143 || buf[i] > 244) return false;
			i += 4;
		} else return false;
		return true;
	}
	/**
	* Determines whether a value is a `Blob`.
	*
	* @param {*} value The value to be tested
	* @return {Boolean} `true` if `value` is a `Blob`, else `false`
	* @private
	*/
	function isBlob$2(value) {
		return hasBlob && typeof value === "object" && typeof value.arrayBuffer === "function" && typeof value.type === "string" && typeof value.stream === "function" && (value[Symbol.toStringTag] === "Blob" || value[Symbol.toStringTag] === "File");
	}
	module.exports = {
		isBlob: isBlob$2,
		isValidStatusCode: isValidStatusCode$2,
		isValidUTF8: _isValidUTF8,
		tokenChars: tokenChars$2
	};
	if (isUtf8) module.exports.isValidUTF8 = function(buf) {
		return buf.length < 24 ? _isValidUTF8(buf) : isUtf8(buf);
	};
	else if (!process.env.WS_NO_UTF_8_VALIDATE) try {
		const isValidUTF8$1 = __require("utf-8-validate");
		module.exports.isValidUTF8 = function(buf) {
			return buf.length < 32 ? _isValidUTF8(buf) : isValidUTF8$1(buf);
		};
	} catch (e) {}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/receiver.js
var require_receiver = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/receiver.js": ((exports, module) => {
	const { Writable } = __require("stream");
	const PerMessageDeflate$4 = require_permessage_deflate();
	const { BINARY_TYPES: BINARY_TYPES$1, EMPTY_BUFFER: EMPTY_BUFFER$2, kStatusCode: kStatusCode$1, kWebSocket: kWebSocket$3 } = require_constants();
	const { concat, toArrayBuffer, unmask } = require_buffer_util();
	const { isValidStatusCode: isValidStatusCode$1, isValidUTF8 } = require_validation();
	const FastBuffer = Buffer[Symbol.species];
	const GET_INFO = 0;
	const GET_PAYLOAD_LENGTH_16 = 1;
	const GET_PAYLOAD_LENGTH_64 = 2;
	const GET_MASK = 3;
	const GET_DATA = 4;
	const INFLATING = 5;
	const DEFER_EVENT = 6;
	/**
	* HyBi Receiver implementation.
	*
	* @extends Writable
	*/
	var Receiver$2 = class extends Writable {
		/**
		* Creates a Receiver instance.
		*
		* @param {Object} [options] Options object
		* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {String} [options.binaryType=nodebuffer] The type for binary data
		* @param {Object} [options.extensions] An object containing the negotiated
		*     extensions
		* @param {Boolean} [options.isServer=false] Specifies whether to operate in
		*     client or server mode
		* @param {Number} [options.maxBufferedChunks=0] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=0] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=0] The maximum allowed message length
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		*/
		constructor(options = {}) {
			super();
			this._allowSynchronousEvents = options.allowSynchronousEvents !== void 0 ? options.allowSynchronousEvents : true;
			this._binaryType = options.binaryType || BINARY_TYPES$1[0];
			this._extensions = options.extensions || {};
			this._isServer = !!options.isServer;
			this._maxBufferedChunks = options.maxBufferedChunks | 0;
			this._maxFragments = options.maxFragments | 0;
			this._maxPayload = options.maxPayload | 0;
			this._skipUTF8Validation = !!options.skipUTF8Validation;
			this[kWebSocket$3] = void 0;
			this._bufferedBytes = 0;
			this._buffers = [];
			this._compressed = false;
			this._payloadLength = 0;
			this._mask = void 0;
			this._fragmented = 0;
			this._masked = false;
			this._fin = false;
			this._opcode = 0;
			this._totalPayloadLength = 0;
			this._messageLength = 0;
			this._numFragments = 0;
			this._fragments = [];
			this._errored = false;
			this._loop = false;
			this._state = GET_INFO;
		}
		/**
		* Implements `Writable.prototype._write()`.
		*
		* @param {Buffer} chunk The chunk of data to write
		* @param {String} encoding The character encoding of `chunk`
		* @param {Function} cb Callback
		* @private
		*/
		_write(chunk, encoding, cb) {
			if (this._opcode === 8 && this._state == GET_INFO) return cb();
			if (this._maxBufferedChunks > 0 && this._buffers.length >= this._maxBufferedChunks) {
				cb(this.createError(RangeError, "Too many buffered chunks", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
				return;
			}
			this._bufferedBytes += chunk.length;
			this._buffers.push(chunk);
			this.startLoop(cb);
		}
		/**
		* Consumes `n` bytes from the buffered data.
		*
		* @param {Number} n The number of bytes to consume
		* @return {Buffer} The consumed bytes
		* @private
		*/
		consume(n) {
			this._bufferedBytes -= n;
			if (n === this._buffers[0].length) return this._buffers.shift();
			if (n < this._buffers[0].length) {
				const buf = this._buffers[0];
				this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
				return new FastBuffer(buf.buffer, buf.byteOffset, n);
			}
			const dst = Buffer.allocUnsafe(n);
			do {
				const buf = this._buffers[0];
				const offset = dst.length - n;
				if (n >= buf.length) dst.set(this._buffers.shift(), offset);
				else {
					dst.set(new Uint8Array(buf.buffer, buf.byteOffset, n), offset);
					this._buffers[0] = new FastBuffer(buf.buffer, buf.byteOffset + n, buf.length - n);
				}
				n -= buf.length;
			} while (n > 0);
			return dst;
		}
		/**
		* Starts the parsing loop.
		*
		* @param {Function} cb Callback
		* @private
		*/
		startLoop(cb) {
			this._loop = true;
			do
				switch (this._state) {
					case GET_INFO:
						this.getInfo(cb);
						break;
					case GET_PAYLOAD_LENGTH_16:
						this.getPayloadLength16(cb);
						break;
					case GET_PAYLOAD_LENGTH_64:
						this.getPayloadLength64(cb);
						break;
					case GET_MASK:
						this.getMask();
						break;
					case GET_DATA:
						this.getData(cb);
						break;
					case INFLATING:
					case DEFER_EVENT:
						this._loop = false;
						return;
				}
			while (this._loop);
			if (!this._errored) cb();
		}
		/**
		* Reads the first two bytes of a frame.
		*
		* @param {Function} cb Callback
		* @private
		*/
		getInfo(cb) {
			if (this._bufferedBytes < 2) {
				this._loop = false;
				return;
			}
			const buf = this.consume(2);
			if ((buf[0] & 48) !== 0) {
				cb(this.createError(RangeError, "RSV2 and RSV3 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_2_3"));
				return;
			}
			const compressed = (buf[0] & 64) === 64;
			if (compressed && !this._extensions[PerMessageDeflate$4.extensionName]) {
				cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
				return;
			}
			this._fin = (buf[0] & 128) === 128;
			this._opcode = buf[0] & 15;
			this._payloadLength = buf[1] & 127;
			if (this._opcode === 0) {
				if (compressed) {
					cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
					return;
				}
				if (!this._fragmented) {
					cb(this.createError(RangeError, "invalid opcode 0", true, 1002, "WS_ERR_INVALID_OPCODE"));
					return;
				}
				this._opcode = this._fragmented;
			} else if (this._opcode === 1 || this._opcode === 2) {
				if (this._fragmented) {
					cb(this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE"));
					return;
				}
				this._compressed = compressed;
			} else if (this._opcode > 7 && this._opcode < 11) {
				if (!this._fin) {
					cb(this.createError(RangeError, "FIN must be set", true, 1002, "WS_ERR_EXPECTED_FIN"));
					return;
				}
				if (compressed) {
					cb(this.createError(RangeError, "RSV1 must be clear", true, 1002, "WS_ERR_UNEXPECTED_RSV_1"));
					return;
				}
				if (this._payloadLength > 125 || this._opcode === 8 && this._payloadLength === 1) {
					cb(this.createError(RangeError, `invalid payload length ${this._payloadLength}`, true, 1002, "WS_ERR_INVALID_CONTROL_PAYLOAD_LENGTH"));
					return;
				}
			} else {
				cb(this.createError(RangeError, `invalid opcode ${this._opcode}`, true, 1002, "WS_ERR_INVALID_OPCODE"));
				return;
			}
			if (!this._fin && !this._fragmented) this._fragmented = this._opcode;
			this._masked = (buf[1] & 128) === 128;
			if (this._isServer) {
				if (!this._masked) {
					cb(this.createError(RangeError, "MASK must be set", true, 1002, "WS_ERR_EXPECTED_MASK"));
					return;
				}
			} else if (this._masked) {
				cb(this.createError(RangeError, "MASK must be clear", true, 1002, "WS_ERR_UNEXPECTED_MASK"));
				return;
			}
			if (this._payloadLength === 126) this._state = GET_PAYLOAD_LENGTH_16;
			else if (this._payloadLength === 127) this._state = GET_PAYLOAD_LENGTH_64;
			else this.haveLength(cb);
		}
		/**
		* Gets extended payload length (7+16).
		*
		* @param {Function} cb Callback
		* @private
		*/
		getPayloadLength16(cb) {
			if (this._bufferedBytes < 2) {
				this._loop = false;
				return;
			}
			this._payloadLength = this.consume(2).readUInt16BE(0);
			this.haveLength(cb);
		}
		/**
		* Gets extended payload length (7+64).
		*
		* @param {Function} cb Callback
		* @private
		*/
		getPayloadLength64(cb) {
			if (this._bufferedBytes < 8) {
				this._loop = false;
				return;
			}
			const buf = this.consume(8);
			const num = buf.readUInt32BE(0);
			if (num > Math.pow(2, 21) - 1) {
				cb(this.createError(RangeError, "Unsupported WebSocket frame: payload length > 2^53 - 1", false, 1009, "WS_ERR_UNSUPPORTED_DATA_PAYLOAD_LENGTH"));
				return;
			}
			this._payloadLength = num * Math.pow(2, 32) + buf.readUInt32BE(4);
			this.haveLength(cb);
		}
		/**
		* Payload length has been read.
		*
		* @param {Function} cb Callback
		* @private
		*/
		haveLength(cb) {
			if (this._payloadLength && this._opcode < 8) {
				this._totalPayloadLength += this._payloadLength;
				if (this._totalPayloadLength > this._maxPayload && this._maxPayload > 0) {
					cb(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
					return;
				}
			}
			if (this._masked) this._state = GET_MASK;
			else this._state = GET_DATA;
		}
		/**
		* Reads mask bytes.
		*
		* @private
		*/
		getMask() {
			if (this._bufferedBytes < 4) {
				this._loop = false;
				return;
			}
			this._mask = this.consume(4);
			this._state = GET_DATA;
		}
		/**
		* Reads data bytes.
		*
		* @param {Function} cb Callback
		* @private
		*/
		getData(cb) {
			let data = EMPTY_BUFFER$2;
			if (this._payloadLength) {
				if (this._bufferedBytes < this._payloadLength) {
					this._loop = false;
					return;
				}
				data = this.consume(this._payloadLength);
				if (this._masked && (this._mask[0] | this._mask[1] | this._mask[2] | this._mask[3]) !== 0) unmask(data, this._mask);
			}
			if (this._opcode > 7) {
				this.controlMessage(data, cb);
				return;
			}
			if (this._maxFragments > 0 && ++this._numFragments > this._maxFragments) {
				cb(this.createError(RangeError, "Too many message fragments", false, 1008, "WS_ERR_TOO_MANY_BUFFERED_PARTS"));
				return;
			}
			if (this._compressed) {
				this._state = INFLATING;
				this.decompress(data, cb);
				return;
			}
			if (data.length) {
				this._messageLength = this._totalPayloadLength;
				this._fragments.push(data);
			}
			this.dataMessage(cb);
		}
		/**
		* Decompresses data.
		*
		* @param {Buffer} data Compressed data
		* @param {Function} cb Callback
		* @private
		*/
		decompress(data, cb) {
			this._extensions[PerMessageDeflate$4.extensionName].decompress(data, this._fin, (err, buf) => {
				if (err) return cb(err);
				if (buf.length) {
					this._messageLength += buf.length;
					if (this._messageLength > this._maxPayload && this._maxPayload > 0) {
						cb(this.createError(RangeError, "Max payload size exceeded", false, 1009, "WS_ERR_UNSUPPORTED_MESSAGE_LENGTH"));
						return;
					}
					this._fragments.push(buf);
				}
				this.dataMessage(cb);
				if (this._state === GET_INFO) this.startLoop(cb);
			});
		}
		/**
		* Handles a data message.
		*
		* @param {Function} cb Callback
		* @private
		*/
		dataMessage(cb) {
			if (!this._fin) {
				this._state = GET_INFO;
				return;
			}
			const messageLength = this._messageLength;
			const fragments = this._fragments;
			this._totalPayloadLength = 0;
			this._messageLength = 0;
			this._fragmented = 0;
			this._numFragments = 0;
			this._fragments = [];
			if (this._opcode === 2) {
				let data;
				if (this._binaryType === "nodebuffer") data = concat(fragments, messageLength);
				else if (this._binaryType === "arraybuffer") data = toArrayBuffer(concat(fragments, messageLength));
				else if (this._binaryType === "blob") data = new Blob(fragments);
				else data = fragments;
				if (this._allowSynchronousEvents) {
					this.emit("message", data, true);
					this._state = GET_INFO;
				} else {
					this._state = DEFER_EVENT;
					setImmediate(() => {
						this.emit("message", data, true);
						this._state = GET_INFO;
						this.startLoop(cb);
					});
				}
			} else {
				const buf = concat(fragments, messageLength);
				if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
					cb(this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
					return;
				}
				if (this._state === INFLATING || this._allowSynchronousEvents) {
					this.emit("message", buf, false);
					this._state = GET_INFO;
				} else {
					this._state = DEFER_EVENT;
					setImmediate(() => {
						this.emit("message", buf, false);
						this._state = GET_INFO;
						this.startLoop(cb);
					});
				}
			}
		}
		/**
		* Handles a control message.
		*
		* @param {Buffer} data Data to handle
		* @return {(Error|RangeError|undefined)} A possible error
		* @private
		*/
		controlMessage(data, cb) {
			if (this._opcode === 8) {
				if (data.length === 0) {
					this._loop = false;
					this.emit("conclude", 1005, EMPTY_BUFFER$2);
					this.end();
				} else {
					const code = data.readUInt16BE(0);
					if (!isValidStatusCode$1(code)) {
						cb(this.createError(RangeError, `invalid status code ${code}`, true, 1002, "WS_ERR_INVALID_CLOSE_CODE"));
						return;
					}
					const buf = new FastBuffer(data.buffer, data.byteOffset + 2, data.length - 2);
					if (!this._skipUTF8Validation && !isValidUTF8(buf)) {
						cb(this.createError(Error, "invalid UTF-8 sequence", true, 1007, "WS_ERR_INVALID_UTF8"));
						return;
					}
					this._loop = false;
					this.emit("conclude", code, buf);
					this.end();
				}
				this._state = GET_INFO;
				return;
			}
			if (this._allowSynchronousEvents) {
				this.emit(this._opcode === 9 ? "ping" : "pong", data);
				this._state = GET_INFO;
			} else {
				this._state = DEFER_EVENT;
				setImmediate(() => {
					this.emit(this._opcode === 9 ? "ping" : "pong", data);
					this._state = GET_INFO;
					this.startLoop(cb);
				});
			}
		}
		/**
		* Builds an error object.
		*
		* @param {function(new:Error|RangeError)} ErrorCtor The error constructor
		* @param {String} message The error message
		* @param {Boolean} prefix Specifies whether or not to add a default prefix to
		*     `message`
		* @param {Number} statusCode The status code
		* @param {String} errorCode The exposed error code
		* @return {(Error|RangeError)} The error
		* @private
		*/
		createError(ErrorCtor, message, prefix, statusCode, errorCode) {
			this._loop = false;
			this._errored = true;
			const err = new ErrorCtor(prefix ? `Invalid WebSocket frame: ${message}` : message);
			Error.captureStackTrace(err, this.createError);
			err.code = errorCode;
			err[kStatusCode$1] = statusCode;
			return err;
		}
	};
	module.exports = Receiver$2;
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/sender.js
var require_sender = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/sender.js": ((exports, module) => {
	const { Duplex: Duplex$3 } = __require("stream");
	const { randomFillSync } = __require("crypto");
	const { types: { isUint8Array } } = __require("util");
	const PerMessageDeflate$3 = require_permessage_deflate();
	const { EMPTY_BUFFER: EMPTY_BUFFER$1, kWebSocket: kWebSocket$2, NOOP: NOOP$1 } = require_constants();
	const { isBlob: isBlob$1, isValidStatusCode } = require_validation();
	const { mask: applyMask, toBuffer: toBuffer$1 } = require_buffer_util();
	const kByteLength = Symbol("kByteLength");
	const maskBuffer = Buffer.alloc(4);
	const RANDOM_POOL_SIZE = 8 * 1024;
	let randomPool;
	let randomPoolPointer = RANDOM_POOL_SIZE;
	const DEFAULT = 0;
	const DEFLATING = 1;
	const GET_BLOB_DATA = 2;
	/**
	* HyBi Sender implementation.
	*/
	var Sender$2 = class Sender$2 {
		/**
		* Creates a Sender instance.
		*
		* @param {Duplex} socket The connection socket
		* @param {Object} [extensions] An object containing the negotiated extensions
		* @param {Function} [generateMask] The function used to generate the masking
		*     key
		*/
		constructor(socket, extensions, generateMask) {
			this._extensions = extensions || {};
			if (generateMask) {
				this._generateMask = generateMask;
				this._maskBuffer = Buffer.alloc(4);
			}
			this._socket = socket;
			this._firstFragment = true;
			this._compress = false;
			this._bufferedBytes = 0;
			this._queue = [];
			this._state = DEFAULT;
			this.onerror = NOOP$1;
			this[kWebSocket$2] = void 0;
		}
		/**
		* Frames a piece of data according to the HyBi WebSocket protocol.
		*
		* @param {(Buffer|String)} data The data to frame
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @return {(Buffer|String)[]} The framed data
		* @public
		*/
		static frame(data, options) {
			let mask;
			let merge = false;
			let offset = 2;
			let skipMasking = false;
			if (options.mask) {
				mask = options.maskBuffer || maskBuffer;
				if (options.generateMask) options.generateMask(mask);
				else {
					if (randomPoolPointer === RANDOM_POOL_SIZE) {
						/* istanbul ignore else  */
						if (randomPool === void 0) randomPool = Buffer.alloc(RANDOM_POOL_SIZE);
						randomFillSync(randomPool, 0, RANDOM_POOL_SIZE);
						randomPoolPointer = 0;
					}
					mask[0] = randomPool[randomPoolPointer++];
					mask[1] = randomPool[randomPoolPointer++];
					mask[2] = randomPool[randomPoolPointer++];
					mask[3] = randomPool[randomPoolPointer++];
				}
				skipMasking = (mask[0] | mask[1] | mask[2] | mask[3]) === 0;
				offset = 6;
			}
			let dataLength;
			if (typeof data === "string") if ((!options.mask || skipMasking) && options[kByteLength] !== void 0) dataLength = options[kByteLength];
			else {
				data = Buffer.from(data);
				dataLength = data.length;
			}
			else {
				dataLength = data.length;
				merge = options.mask && options.readOnly && !skipMasking;
			}
			let payloadLength = dataLength;
			if (dataLength >= 65536) {
				offset += 8;
				payloadLength = 127;
			} else if (dataLength > 125) {
				offset += 2;
				payloadLength = 126;
			}
			const target = Buffer.allocUnsafe(merge ? dataLength + offset : offset);
			target[0] = options.fin ? options.opcode | 128 : options.opcode;
			if (options.rsv1) target[0] |= 64;
			target[1] = payloadLength;
			if (payloadLength === 126) target.writeUInt16BE(dataLength, 2);
			else if (payloadLength === 127) {
				target[2] = target[3] = 0;
				target.writeUIntBE(dataLength, 4, 6);
			}
			if (!options.mask) return [target, data];
			target[1] |= 128;
			target[offset - 4] = mask[0];
			target[offset - 3] = mask[1];
			target[offset - 2] = mask[2];
			target[offset - 1] = mask[3];
			if (skipMasking) return [target, data];
			if (merge) {
				applyMask(data, mask, target, offset, dataLength);
				return [target];
			}
			applyMask(data, mask, data, 0, dataLength);
			return [target, data];
		}
		/**
		* Sends a close message to the other peer.
		*
		* @param {Number} [code] The status code component of the body
		* @param {(String|Buffer)} [data] The message component of the body
		* @param {Boolean} [mask=false] Specifies whether or not to mask the message
		* @param {Function} [cb] Callback
		* @public
		*/
		close(code, data, mask, cb) {
			let buf;
			if (code === void 0) buf = EMPTY_BUFFER$1;
			else if (typeof code !== "number" || !isValidStatusCode(code)) throw new TypeError("First argument must be a valid error code number");
			else if (data === void 0 || !data.length) {
				buf = Buffer.allocUnsafe(2);
				buf.writeUInt16BE(code, 0);
			} else {
				const length = Buffer.byteLength(data);
				if (length > 123) throw new RangeError("The message must not be greater than 123 bytes");
				buf = Buffer.allocUnsafe(2 + length);
				buf.writeUInt16BE(code, 0);
				if (typeof data === "string") buf.write(data, 2);
				else if (isUint8Array(data)) buf.set(data, 2);
				else throw new TypeError("Second argument must be a string or a Uint8Array");
			}
			const options = {
				[kByteLength]: buf.length,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 8,
				readOnly: false,
				rsv1: false
			};
			if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				buf,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender$2.frame(buf, options), cb);
		}
		/**
		* Sends a ping message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Boolean} [mask=false] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		ping(data, mask, cb) {
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob$1(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer$1(data);
				byteLength = data.length;
				readOnly = toBuffer$1.readOnly;
			}
			if (byteLength > 125) throw new RangeError("The data size must not be greater than 125 bytes");
			const options = {
				[kByteLength]: byteLength,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 9,
				readOnly,
				rsv1: false
			};
			if (isBlob$1(data)) if (this._state !== DEFAULT) this.enqueue([
				this.getBlobData,
				data,
				false,
				options,
				cb
			]);
			else this.getBlobData(data, false, options, cb);
			else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender$2.frame(data, options), cb);
		}
		/**
		* Sends a pong message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Boolean} [mask=false] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		pong(data, mask, cb) {
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob$1(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer$1(data);
				byteLength = data.length;
				readOnly = toBuffer$1.readOnly;
			}
			if (byteLength > 125) throw new RangeError("The data size must not be greater than 125 bytes");
			const options = {
				[kByteLength]: byteLength,
				fin: true,
				generateMask: this._generateMask,
				mask,
				maskBuffer: this._maskBuffer,
				opcode: 10,
				readOnly,
				rsv1: false
			};
			if (isBlob$1(data)) if (this._state !== DEFAULT) this.enqueue([
				this.getBlobData,
				data,
				false,
				options,
				cb
			]);
			else this.getBlobData(data, false, options, cb);
			else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				false,
				options,
				cb
			]);
			else this.sendFrame(Sender$2.frame(data, options), cb);
		}
		/**
		* Sends a data message to the other peer.
		*
		* @param {*} data The message to send
		* @param {Object} options Options object
		* @param {Boolean} [options.binary=false] Specifies whether `data` is binary
		*     or text
		* @param {Boolean} [options.compress=false] Specifies whether or not to
		*     compress `data`
		* @param {Boolean} [options.fin=false] Specifies whether the fragment is the
		*     last one
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Function} [cb] Callback
		* @public
		*/
		send(data, options, cb) {
			const perMessageDeflate = this._extensions[PerMessageDeflate$3.extensionName];
			let opcode = options.binary ? 2 : 1;
			let rsv1 = options.compress;
			let byteLength;
			let readOnly;
			if (typeof data === "string") {
				byteLength = Buffer.byteLength(data);
				readOnly = false;
			} else if (isBlob$1(data)) {
				byteLength = data.size;
				readOnly = false;
			} else {
				data = toBuffer$1(data);
				byteLength = data.length;
				readOnly = toBuffer$1.readOnly;
			}
			if (this._firstFragment) {
				this._firstFragment = false;
				if (rsv1 && perMessageDeflate && perMessageDeflate.params[perMessageDeflate._isServer ? "server_no_context_takeover" : "client_no_context_takeover"]) rsv1 = byteLength >= perMessageDeflate._threshold;
				this._compress = rsv1;
			} else {
				rsv1 = false;
				opcode = 0;
			}
			if (options.fin) this._firstFragment = true;
			const opts = {
				[kByteLength]: byteLength,
				fin: options.fin,
				generateMask: this._generateMask,
				mask: options.mask,
				maskBuffer: this._maskBuffer,
				opcode,
				readOnly,
				rsv1
			};
			if (isBlob$1(data)) if (this._state !== DEFAULT) this.enqueue([
				this.getBlobData,
				data,
				this._compress,
				opts,
				cb
			]);
			else this.getBlobData(data, this._compress, opts, cb);
			else if (this._state !== DEFAULT) this.enqueue([
				this.dispatch,
				data,
				this._compress,
				opts,
				cb
			]);
			else this.dispatch(data, this._compress, opts, cb);
		}
		/**
		* Gets the contents of a blob as binary data.
		*
		* @param {Blob} blob The blob
		* @param {Boolean} [compress=false] Specifies whether or not to compress
		*     the data
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @param {Function} [cb] Callback
		* @private
		*/
		getBlobData(blob, compress, options, cb) {
			this._bufferedBytes += options[kByteLength];
			this._state = GET_BLOB_DATA;
			blob.arrayBuffer().then((arrayBuffer) => {
				if (this._socket.destroyed) {
					const err = /* @__PURE__ */ new Error("The socket was closed while the blob was being read");
					process.nextTick(callCallbacks, this, err, cb);
					return;
				}
				this._bufferedBytes -= options[kByteLength];
				const data = toBuffer$1(arrayBuffer);
				if (!compress) {
					this._state = DEFAULT;
					this.sendFrame(Sender$2.frame(data, options), cb);
					this.dequeue();
				} else this.dispatch(data, compress, options, cb);
			}).catch((err) => {
				process.nextTick(onError, this, err, cb);
			});
		}
		/**
		* Dispatches a message.
		*
		* @param {(Buffer|String)} data The message to send
		* @param {Boolean} [compress=false] Specifies whether or not to compress
		*     `data`
		* @param {Object} options Options object
		* @param {Boolean} [options.fin=false] Specifies whether or not to set the
		*     FIN bit
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Boolean} [options.mask=false] Specifies whether or not to mask
		*     `data`
		* @param {Buffer} [options.maskBuffer] The buffer used to store the masking
		*     key
		* @param {Number} options.opcode The opcode
		* @param {Boolean} [options.readOnly=false] Specifies whether `data` can be
		*     modified
		* @param {Boolean} [options.rsv1=false] Specifies whether or not to set the
		*     RSV1 bit
		* @param {Function} [cb] Callback
		* @private
		*/
		dispatch(data, compress, options, cb) {
			if (!compress) {
				this.sendFrame(Sender$2.frame(data, options), cb);
				return;
			}
			const perMessageDeflate = this._extensions[PerMessageDeflate$3.extensionName];
			this._bufferedBytes += options[kByteLength];
			this._state = DEFLATING;
			perMessageDeflate.compress(data, options.fin, (_, buf) => {
				if (this._socket.destroyed) {
					callCallbacks(this, /* @__PURE__ */ new Error("The socket was closed while data was being compressed"), cb);
					return;
				}
				this._bufferedBytes -= options[kByteLength];
				this._state = DEFAULT;
				options.readOnly = false;
				this.sendFrame(Sender$2.frame(buf, options), cb);
				this.dequeue();
			});
		}
		/**
		* Executes queued send operations.
		*
		* @private
		*/
		dequeue() {
			while (this._state === DEFAULT && this._queue.length) {
				const params = this._queue.shift();
				this._bufferedBytes -= params[3][kByteLength];
				Reflect.apply(params[0], this, params.slice(1));
			}
		}
		/**
		* Enqueues a send operation.
		*
		* @param {Array} params Send operation parameters.
		* @private
		*/
		enqueue(params) {
			this._bufferedBytes += params[3][kByteLength];
			this._queue.push(params);
		}
		/**
		* Sends a frame.
		*
		* @param {(Buffer | String)[]} list The frame to send
		* @param {Function} [cb] Callback
		* @private
		*/
		sendFrame(list, cb) {
			if (list.length === 2) {
				this._socket.cork();
				this._socket.write(list[0]);
				this._socket.write(list[1], cb);
				this._socket.uncork();
			} else this._socket.write(list[0], cb);
		}
	};
	module.exports = Sender$2;
	/**
	* Calls queued callbacks with an error.
	*
	* @param {Sender} sender The `Sender` instance
	* @param {Error} err The error to call the callbacks with
	* @param {Function} [cb] The first callback
	* @private
	*/
	function callCallbacks(sender, err, cb) {
		if (typeof cb === "function") cb(err);
		for (let i = 0; i < sender._queue.length; i++) {
			const params = sender._queue[i];
			const callback = params[params.length - 1];
			if (typeof callback === "function") callback(err);
		}
	}
	/**
	* Handles a `Sender` error.
	*
	* @param {Sender} sender The `Sender` instance
	* @param {Error} err The error
	* @param {Function} [cb] The first pending callback
	* @private
	*/
	function onError(sender, err, cb) {
		callCallbacks(sender, err, cb);
		sender.onerror(err);
	}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/event-target.js
var require_event_target = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/event-target.js": ((exports, module) => {
	const { kForOnEventAttribute: kForOnEventAttribute$1, kListener: kListener$1 } = require_constants();
	const kCode = Symbol("kCode");
	const kData = Symbol("kData");
	const kError = Symbol("kError");
	const kMessage = Symbol("kMessage");
	const kReason = Symbol("kReason");
	const kTarget = Symbol("kTarget");
	const kType = Symbol("kType");
	const kWasClean = Symbol("kWasClean");
	/**
	* Class representing an event.
	*/
	var Event = class {
		/**
		* Create a new `Event`.
		*
		* @param {String} type The name of the event
		* @throws {TypeError} If the `type` argument is not specified
		*/
		constructor(type) {
			this[kTarget] = null;
			this[kType] = type;
		}
		/**
		* @type {*}
		*/
		get target() {
			return this[kTarget];
		}
		/**
		* @type {String}
		*/
		get type() {
			return this[kType];
		}
	};
	Object.defineProperty(Event.prototype, "target", { enumerable: true });
	Object.defineProperty(Event.prototype, "type", { enumerable: true });
	/**
	* Class representing a close event.
	*
	* @extends Event
	*/
	var CloseEvent = class extends Event {
		/**
		* Create a new `CloseEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {Number} [options.code=0] The status code explaining why the
		*     connection was closed
		* @param {String} [options.reason=''] A human-readable string explaining why
		*     the connection was closed
		* @param {Boolean} [options.wasClean=false] Indicates whether or not the
		*     connection was cleanly closed
		*/
		constructor(type, options = {}) {
			super(type);
			this[kCode] = options.code === void 0 ? 0 : options.code;
			this[kReason] = options.reason === void 0 ? "" : options.reason;
			this[kWasClean] = options.wasClean === void 0 ? false : options.wasClean;
		}
		/**
		* @type {Number}
		*/
		get code() {
			return this[kCode];
		}
		/**
		* @type {String}
		*/
		get reason() {
			return this[kReason];
		}
		/**
		* @type {Boolean}
		*/
		get wasClean() {
			return this[kWasClean];
		}
	};
	Object.defineProperty(CloseEvent.prototype, "code", { enumerable: true });
	Object.defineProperty(CloseEvent.prototype, "reason", { enumerable: true });
	Object.defineProperty(CloseEvent.prototype, "wasClean", { enumerable: true });
	/**
	* Class representing an error event.
	*
	* @extends Event
	*/
	var ErrorEvent = class extends Event {
		/**
		* Create a new `ErrorEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {*} [options.error=null] The error that generated this event
		* @param {String} [options.message=''] The error message
		*/
		constructor(type, options = {}) {
			super(type);
			this[kError] = options.error === void 0 ? null : options.error;
			this[kMessage] = options.message === void 0 ? "" : options.message;
		}
		/**
		* @type {*}
		*/
		get error() {
			return this[kError];
		}
		/**
		* @type {String}
		*/
		get message() {
			return this[kMessage];
		}
	};
	Object.defineProperty(ErrorEvent.prototype, "error", { enumerable: true });
	Object.defineProperty(ErrorEvent.prototype, "message", { enumerable: true });
	/**
	* Class representing a message event.
	*
	* @extends Event
	*/
	var MessageEvent = class extends Event {
		/**
		* Create a new `MessageEvent`.
		*
		* @param {String} type The name of the event
		* @param {Object} [options] A dictionary object that allows for setting
		*     attributes via object members of the same name
		* @param {*} [options.data=null] The message content
		*/
		constructor(type, options = {}) {
			super(type);
			this[kData] = options.data === void 0 ? null : options.data;
		}
		/**
		* @type {*}
		*/
		get data() {
			return this[kData];
		}
	};
	Object.defineProperty(MessageEvent.prototype, "data", { enumerable: true });
	/**
	* This provides methods for emulating the `EventTarget` interface. It's not
	* meant to be used directly.
	*
	* @mixin
	*/
	const EventTarget = {
		addEventListener(type, handler, options = {}) {
			for (const listener of this.listeners(type)) if (!options[kForOnEventAttribute$1] && listener[kListener$1] === handler && !listener[kForOnEventAttribute$1]) return;
			let wrapper;
			if (type === "message") wrapper = function onMessage(data, isBinary) {
				const event = new MessageEvent("message", { data: isBinary ? data : data.toString() });
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else if (type === "close") wrapper = function onClose(code, message) {
				const event = new CloseEvent("close", {
					code,
					reason: message.toString(),
					wasClean: this._closeFrameReceived && this._closeFrameSent
				});
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else if (type === "error") wrapper = function onError$1(error) {
				const event = new ErrorEvent("error", {
					error,
					message: error.message
				});
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else if (type === "open") wrapper = function onOpen() {
				const event = new Event("open");
				event[kTarget] = this;
				callListener(handler, this, event);
			};
			else return;
			wrapper[kForOnEventAttribute$1] = !!options[kForOnEventAttribute$1];
			wrapper[kListener$1] = handler;
			if (options.once) this.once(type, wrapper);
			else this.on(type, wrapper);
		},
		removeEventListener(type, handler) {
			for (const listener of this.listeners(type)) if (listener[kListener$1] === handler && !listener[kForOnEventAttribute$1]) {
				this.removeListener(type, listener);
				break;
			}
		}
	};
	module.exports = {
		CloseEvent,
		ErrorEvent,
		Event,
		EventTarget,
		MessageEvent
	};
	/**
	* Call an event listener
	*
	* @param {(Function|Object)} listener The listener to call
	* @param {*} thisArg The value to use as `this`` when calling the listener
	* @param {Event} event The event to pass to the listener
	* @private
	*/
	function callListener(listener, thisArg, event) {
		if (typeof listener === "object" && listener.handleEvent) listener.handleEvent.call(listener, event);
		else listener.call(thisArg, event);
	}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/extension.js
var require_extension = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/extension.js": ((exports, module) => {
	const { tokenChars: tokenChars$1 } = require_validation();
	/**
	* Adds an offer to the map of extension offers or a parameter to the map of
	* parameters.
	*
	* @param {Object} dest The map of extension offers or parameters
	* @param {String} name The extension or parameter name
	* @param {(Object|Boolean|String)} elem The extension parameters or the
	*     parameter value
	* @private
	*/
	function push(dest, name, elem) {
		if (dest[name] === void 0) dest[name] = [elem];
		else dest[name].push(elem);
	}
	/**
	* Parses the `Sec-WebSocket-Extensions` header into an object.
	*
	* @param {String} header The field value of the header
	* @return {Object} The parsed object
	* @public
	*/
	function parse$2(header) {
		const offers = Object.create(null);
		let params = Object.create(null);
		let mustUnescape = false;
		let isEscaping = false;
		let inQuotes = false;
		let extensionName;
		let paramName;
		let start = -1;
		let code = -1;
		let end = -1;
		let i = 0;
		for (; i < header.length; i++) {
			code = header.charCodeAt(i);
			if (extensionName === void 0) if (end === -1 && tokenChars$1[code] === 1) {
				if (start === -1) start = i;
			} else if (i !== 0 && (code === 32 || code === 9)) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				const name = header.slice(start, end);
				if (code === 44) {
					push(offers, name, params);
					params = Object.create(null);
				} else extensionName = name;
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
			else if (paramName === void 0) if (end === -1 && tokenChars$1[code] === 1) {
				if (start === -1) start = i;
			} else if (code === 32 || code === 9) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				push(params, header.slice(start, end), true);
				if (code === 44) {
					push(offers, extensionName, params);
					params = Object.create(null);
					extensionName = void 0;
				}
				start = end = -1;
			} else if (code === 61 && start !== -1 && end === -1) {
				paramName = header.slice(start, i);
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
			else if (isEscaping) {
				if (tokenChars$1[code] !== 1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (start === -1) start = i;
				else if (!mustUnescape) mustUnescape = true;
				isEscaping = false;
			} else if (inQuotes) if (tokenChars$1[code] === 1) {
				if (start === -1) start = i;
			} else if (code === 34 && start !== -1) {
				inQuotes = false;
				end = i;
			} else if (code === 92) isEscaping = true;
			else throw new SyntaxError(`Unexpected character at index ${i}`);
			else if (code === 34 && header.charCodeAt(i - 1) === 61) inQuotes = true;
			else if (end === -1 && tokenChars$1[code] === 1) {
				if (start === -1) start = i;
			} else if (start !== -1 && (code === 32 || code === 9)) {
				if (end === -1) end = i;
			} else if (code === 59 || code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				let value = header.slice(start, end);
				if (mustUnescape) {
					value = value.replace(/\\/g, "");
					mustUnescape = false;
				}
				push(params, paramName, value);
				if (code === 44) {
					push(offers, extensionName, params);
					params = Object.create(null);
					extensionName = void 0;
				}
				paramName = void 0;
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
		}
		if (start === -1 || inQuotes || code === 32 || code === 9) throw new SyntaxError("Unexpected end of input");
		if (end === -1) end = i;
		const token = header.slice(start, end);
		if (extensionName === void 0) push(offers, token, params);
		else {
			if (paramName === void 0) push(params, token, true);
			else if (mustUnescape) push(params, paramName, token.replace(/\\/g, ""));
			else push(params, paramName, token);
			push(offers, extensionName, params);
		}
		return offers;
	}
	/**
	* Builds the `Sec-WebSocket-Extensions` header field value.
	*
	* @param {Object} extensions The map of extensions and parameters to format
	* @return {String} A string representing the given object
	* @public
	*/
	function format$1(extensions) {
		return Object.keys(extensions).map((extension$2) => {
			let configurations = extensions[extension$2];
			if (!Array.isArray(configurations)) configurations = [configurations];
			return configurations.map((params) => {
				return [extension$2].concat(Object.keys(params).map((k) => {
					let values = params[k];
					if (!Array.isArray(values)) values = [values];
					return values.map((v) => v === true ? k : `${k}=${v}`).join("; ");
				})).join("; ");
			}).join(", ");
		}).join(", ");
	}
	module.exports = {
		format: format$1,
		parse: parse$2
	};
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket.js
var require_websocket = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket.js": ((exports, module) => {
	const EventEmitter$1 = __require("events");
	const https = __require("https");
	const http$1 = __require("http");
	const net = __require("net");
	const tls = __require("tls");
	const { randomBytes, createHash: createHash$1 } = __require("crypto");
	const { Duplex: Duplex$2, Readable } = __require("stream");
	const { URL: URL$1 } = __require("url");
	const PerMessageDeflate$2 = require_permessage_deflate();
	const Receiver$1 = require_receiver();
	const Sender$1 = require_sender();
	const { isBlob } = require_validation();
	const { BINARY_TYPES, CLOSE_TIMEOUT: CLOSE_TIMEOUT$1, EMPTY_BUFFER, GUID: GUID$1, kForOnEventAttribute, kListener, kStatusCode, kWebSocket: kWebSocket$1, NOOP } = require_constants();
	const { EventTarget: { addEventListener, removeEventListener } } = require_event_target();
	const { format, parse: parse$1 } = require_extension();
	const { toBuffer } = require_buffer_util();
	const kAborted = Symbol("kAborted");
	const protocolVersions = [8, 13];
	const readyStates = [
		"CONNECTING",
		"OPEN",
		"CLOSING",
		"CLOSED"
	];
	const subprotocolRegex = /^[!#$%&'*+\-.0-9A-Z^_`|a-z~]+$/;
	/**
	* Class representing a WebSocket.
	*
	* @extends EventEmitter
	*/
	var WebSocket$3 = class WebSocket$3 extends EventEmitter$1 {
		/**
		* Create a new `WebSocket`.
		*
		* @param {(String|URL)} address The URL to which to connect
		* @param {(String|String[])} [protocols] The subprotocols
		* @param {Object} [options] Connection options
		*/
		constructor(address, protocols, options) {
			super();
			this._binaryType = BINARY_TYPES[0];
			this._closeCode = 1006;
			this._closeFrameReceived = false;
			this._closeFrameSent = false;
			this._closeMessage = EMPTY_BUFFER;
			this._closeTimer = null;
			this._errorEmitted = false;
			this._extensions = {};
			this._paused = false;
			this._protocol = "";
			this._readyState = WebSocket$3.CONNECTING;
			this._receiver = null;
			this._sender = null;
			this._socket = null;
			if (address !== null) {
				this._bufferedAmount = 0;
				this._isServer = false;
				this._redirects = 0;
				if (protocols === void 0) protocols = [];
				else if (!Array.isArray(protocols)) if (typeof protocols === "object" && protocols !== null) {
					options = protocols;
					protocols = [];
				} else protocols = [protocols];
				initAsClient(this, address, protocols, options);
			} else {
				this._autoPong = options.autoPong;
				this._closeTimeout = options.closeTimeout;
				this._isServer = true;
			}
		}
		/**
		* For historical reasons, the custom "nodebuffer" type is used by the default
		* instead of "blob".
		*
		* @type {String}
		*/
		get binaryType() {
			return this._binaryType;
		}
		set binaryType(type) {
			if (!BINARY_TYPES.includes(type)) return;
			this._binaryType = type;
			if (this._receiver) this._receiver._binaryType = type;
		}
		/**
		* @type {Number}
		*/
		get bufferedAmount() {
			if (!this._socket) return this._bufferedAmount;
			return this._socket._writableState.length + this._sender._bufferedBytes;
		}
		/**
		* @type {String}
		*/
		get extensions() {
			return Object.keys(this._extensions).join();
		}
		/**
		* @type {Boolean}
		*/
		get isPaused() {
			return this._paused;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onclose() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onerror() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onopen() {
			return null;
		}
		/**
		* @type {Function}
		*/
		/* istanbul ignore next */
		get onmessage() {
			return null;
		}
		/**
		* @type {String}
		*/
		get protocol() {
			return this._protocol;
		}
		/**
		* @type {Number}
		*/
		get readyState() {
			return this._readyState;
		}
		/**
		* @type {String}
		*/
		get url() {
			return this._url;
		}
		/**
		* Set up the socket and the internal resources.
		*
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Object} options Options object
		* @param {Boolean} [options.allowSynchronousEvents=false] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {Function} [options.generateMask] The function used to generate the
		*     masking key
		* @param {Number} [options.maxBufferedChunks=0] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=0] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=0] The maximum allowed message size
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		* @private
		*/
		setSocket(socket, head, options) {
			const receiver = new Receiver$1({
				allowSynchronousEvents: options.allowSynchronousEvents,
				binaryType: this.binaryType,
				extensions: this._extensions,
				isServer: this._isServer,
				maxBufferedChunks: options.maxBufferedChunks,
				maxFragments: options.maxFragments,
				maxPayload: options.maxPayload,
				skipUTF8Validation: options.skipUTF8Validation
			});
			const sender = new Sender$1(socket, this._extensions, options.generateMask);
			this._receiver = receiver;
			this._sender = sender;
			this._socket = socket;
			receiver[kWebSocket$1] = this;
			sender[kWebSocket$1] = this;
			socket[kWebSocket$1] = this;
			receiver.on("conclude", receiverOnConclude);
			receiver.on("drain", receiverOnDrain);
			receiver.on("error", receiverOnError);
			receiver.on("message", receiverOnMessage);
			receiver.on("ping", receiverOnPing);
			receiver.on("pong", receiverOnPong);
			sender.onerror = senderOnError;
			if (socket.setTimeout) socket.setTimeout(0);
			if (socket.setNoDelay) socket.setNoDelay();
			if (head.length > 0) socket.unshift(head);
			socket.on("close", socketOnClose);
			socket.on("data", socketOnData);
			socket.on("end", socketOnEnd);
			socket.on("error", socketOnError$1);
			this._readyState = WebSocket$3.OPEN;
			this.emit("open");
		}
		/**
		* Emit the `'close'` event.
		*
		* @private
		*/
		emitClose() {
			if (!this._socket) {
				this._readyState = WebSocket$3.CLOSED;
				this.emit("close", this._closeCode, this._closeMessage);
				return;
			}
			if (this._extensions[PerMessageDeflate$2.extensionName]) this._extensions[PerMessageDeflate$2.extensionName].cleanup();
			this._receiver.removeAllListeners();
			this._readyState = WebSocket$3.CLOSED;
			this.emit("close", this._closeCode, this._closeMessage);
		}
		/**
		* Start a closing handshake.
		*
		*          +----------+   +-----------+   +----------+
		*     - - -|ws.close()|-->|close frame|-->|ws.close()|- - -
		*    |     +----------+   +-----------+   +----------+     |
		*          +----------+   +-----------+         |
		* CLOSING  |ws.close()|<--|close frame|<--+-----+       CLOSING
		*          +----------+   +-----------+   |
		*    |           |                        |   +---+        |
		*                +------------------------+-->|fin| - - - -
		*    |         +---+                      |   +---+
		*     - - - - -|fin|<---------------------+
		*              +---+
		*
		* @param {Number} [code] Status code explaining why the connection is closing
		* @param {(String|Buffer)} [data] The reason why the connection is
		*     closing
		* @public
		*/
		close(code, data) {
			if (this.readyState === WebSocket$3.CLOSED) return;
			if (this.readyState === WebSocket$3.CONNECTING) {
				abortHandshake$1(this, this._req, "WebSocket was closed before the connection was established");
				return;
			}
			if (this.readyState === WebSocket$3.CLOSING) {
				if (this._closeFrameSent && (this._closeFrameReceived || this._receiver._writableState.errorEmitted)) this._socket.end();
				return;
			}
			this._readyState = WebSocket$3.CLOSING;
			this._sender.close(code, data, !this._isServer, (err) => {
				if (err) return;
				this._closeFrameSent = true;
				if (this._closeFrameReceived || this._receiver._writableState.errorEmitted) this._socket.end();
			});
			setCloseTimer(this);
		}
		/**
		* Pause the socket.
		*
		* @public
		*/
		pause() {
			if (this.readyState === WebSocket$3.CONNECTING || this.readyState === WebSocket$3.CLOSED) return;
			this._paused = true;
			this._socket.pause();
		}
		/**
		* Send a ping.
		*
		* @param {*} [data] The data to send
		* @param {Boolean} [mask] Indicates whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when the ping is sent
		* @public
		*/
		ping(data, mask, cb) {
			if (this.readyState === WebSocket$3.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof data === "function") {
				cb = data;
				data = mask = void 0;
			} else if (typeof mask === "function") {
				cb = mask;
				mask = void 0;
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket$3.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			if (mask === void 0) mask = !this._isServer;
			this._sender.ping(data || EMPTY_BUFFER, mask, cb);
		}
		/**
		* Send a pong.
		*
		* @param {*} [data] The data to send
		* @param {Boolean} [mask] Indicates whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when the pong is sent
		* @public
		*/
		pong(data, mask, cb) {
			if (this.readyState === WebSocket$3.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof data === "function") {
				cb = data;
				data = mask = void 0;
			} else if (typeof mask === "function") {
				cb = mask;
				mask = void 0;
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket$3.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			if (mask === void 0) mask = !this._isServer;
			this._sender.pong(data || EMPTY_BUFFER, mask, cb);
		}
		/**
		* Resume the socket.
		*
		* @public
		*/
		resume() {
			if (this.readyState === WebSocket$3.CONNECTING || this.readyState === WebSocket$3.CLOSED) return;
			this._paused = false;
			if (!this._receiver._writableState.needDrain) this._socket.resume();
		}
		/**
		* Send a data message.
		*
		* @param {*} data The message to send
		* @param {Object} [options] Options object
		* @param {Boolean} [options.binary] Specifies whether `data` is binary or
		*     text
		* @param {Boolean} [options.compress] Specifies whether or not to compress
		*     `data`
		* @param {Boolean} [options.fin=true] Specifies whether the fragment is the
		*     last one
		* @param {Boolean} [options.mask] Specifies whether or not to mask `data`
		* @param {Function} [cb] Callback which is executed when data is written out
		* @public
		*/
		send(data, options, cb) {
			if (this.readyState === WebSocket$3.CONNECTING) throw new Error("WebSocket is not open: readyState 0 (CONNECTING)");
			if (typeof options === "function") {
				cb = options;
				options = {};
			}
			if (typeof data === "number") data = data.toString();
			if (this.readyState !== WebSocket$3.OPEN) {
				sendAfterClose(this, data, cb);
				return;
			}
			const opts = {
				binary: typeof data !== "string",
				mask: !this._isServer,
				compress: true,
				fin: true,
				...options
			};
			if (!this._extensions[PerMessageDeflate$2.extensionName]) opts.compress = false;
			this._sender.send(data || EMPTY_BUFFER, opts, cb);
		}
		/**
		* Forcibly close the connection.
		*
		* @public
		*/
		terminate() {
			if (this.readyState === WebSocket$3.CLOSED) return;
			if (this.readyState === WebSocket$3.CONNECTING) {
				abortHandshake$1(this, this._req, "WebSocket was closed before the connection was established");
				return;
			}
			if (this._socket) {
				this._readyState = WebSocket$3.CLOSING;
				this._socket.destroy();
			}
		}
	};
	/**
	* @constant {Number} CONNECTING
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket$3, "CONNECTING", {
		enumerable: true,
		value: readyStates.indexOf("CONNECTING")
	});
	/**
	* @constant {Number} CONNECTING
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket$3.prototype, "CONNECTING", {
		enumerable: true,
		value: readyStates.indexOf("CONNECTING")
	});
	/**
	* @constant {Number} OPEN
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket$3, "OPEN", {
		enumerable: true,
		value: readyStates.indexOf("OPEN")
	});
	/**
	* @constant {Number} OPEN
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket$3.prototype, "OPEN", {
		enumerable: true,
		value: readyStates.indexOf("OPEN")
	});
	/**
	* @constant {Number} CLOSING
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket$3, "CLOSING", {
		enumerable: true,
		value: readyStates.indexOf("CLOSING")
	});
	/**
	* @constant {Number} CLOSING
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket$3.prototype, "CLOSING", {
		enumerable: true,
		value: readyStates.indexOf("CLOSING")
	});
	/**
	* @constant {Number} CLOSED
	* @memberof WebSocket
	*/
	Object.defineProperty(WebSocket$3, "CLOSED", {
		enumerable: true,
		value: readyStates.indexOf("CLOSED")
	});
	/**
	* @constant {Number} CLOSED
	* @memberof WebSocket.prototype
	*/
	Object.defineProperty(WebSocket$3.prototype, "CLOSED", {
		enumerable: true,
		value: readyStates.indexOf("CLOSED")
	});
	[
		"binaryType",
		"bufferedAmount",
		"extensions",
		"isPaused",
		"protocol",
		"readyState",
		"url"
	].forEach((property) => {
		Object.defineProperty(WebSocket$3.prototype, property, { enumerable: true });
	});
	[
		"open",
		"error",
		"close",
		"message"
	].forEach((method) => {
		Object.defineProperty(WebSocket$3.prototype, `on${method}`, {
			enumerable: true,
			get() {
				for (const listener of this.listeners(method)) if (listener[kForOnEventAttribute]) return listener[kListener];
				return null;
			},
			set(handler) {
				for (const listener of this.listeners(method)) if (listener[kForOnEventAttribute]) {
					this.removeListener(method, listener);
					break;
				}
				if (typeof handler !== "function") return;
				this.addEventListener(method, handler, { [kForOnEventAttribute]: true });
			}
		});
	});
	WebSocket$3.prototype.addEventListener = addEventListener;
	WebSocket$3.prototype.removeEventListener = removeEventListener;
	module.exports = WebSocket$3;
	/**
	* Initialize a WebSocket client.
	*
	* @param {WebSocket} websocket The client to initialize
	* @param {(String|URL)} address The URL to which to connect
	* @param {Array} protocols The subprotocols
	* @param {Object} [options] Connection options
	* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether any
	*     of the `'message'`, `'ping'`, and `'pong'` events can be emitted multiple
	*     times in the same tick
	* @param {Boolean} [options.autoPong=true] Specifies whether or not to
	*     automatically send a pong in response to a ping
	* @param {Number} [options.closeTimeout=30000] Duration in milliseconds to wait
	*     for the closing handshake to finish after `websocket.close()` is called
	* @param {Function} [options.finishRequest] A function which can be used to
	*     customize the headers of each http request before it is sent
	* @param {Boolean} [options.followRedirects=false] Whether or not to follow
	*     redirects
	* @param {Function} [options.generateMask] The function used to generate the
	*     masking key
	* @param {Number} [options.handshakeTimeout] Timeout in milliseconds for the
	*     handshake request
	* @param {Number} [options.maxBufferedChunks=262144] The maximum number of
	*     buffered data chunks
	* @param {Number} [options.maxFragments=16384] The maximum number of message
	*     fragments
	* @param {Number} [options.maxPayload=104857600] The maximum allowed message
	*     size
	* @param {Number} [options.maxRedirects=10] The maximum number of redirects
	*     allowed
	* @param {String} [options.origin] Value of the `Origin` or
	*     `Sec-WebSocket-Origin` header
	* @param {(Boolean|Object)} [options.perMessageDeflate=true] Enable/disable
	*     permessage-deflate
	* @param {Number} [options.protocolVersion=13] Value of the
	*     `Sec-WebSocket-Version` header
	* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
	*     not to skip UTF-8 validation for text and close messages
	* @private
	*/
	function initAsClient(websocket, address, protocols, options) {
		const opts = {
			allowSynchronousEvents: true,
			autoPong: true,
			closeTimeout: CLOSE_TIMEOUT$1,
			protocolVersion: protocolVersions[1],
			maxBufferedChunks: 256 * 1024,
			maxFragments: 16 * 1024,
			maxPayload: 100 * 1024 * 1024,
			skipUTF8Validation: false,
			perMessageDeflate: true,
			followRedirects: false,
			maxRedirects: 10,
			...options,
			socketPath: void 0,
			hostname: void 0,
			protocol: void 0,
			timeout: void 0,
			method: "GET",
			host: void 0,
			path: void 0,
			port: void 0
		};
		websocket._autoPong = opts.autoPong;
		websocket._closeTimeout = opts.closeTimeout;
		if (!protocolVersions.includes(opts.protocolVersion)) throw new RangeError(`Unsupported protocol version: ${opts.protocolVersion} (supported versions: ${protocolVersions.join(", ")})`);
		let parsedUrl;
		if (address instanceof URL$1) parsedUrl = address;
		else try {
			parsedUrl = new URL$1(address);
		} catch {
			throw new SyntaxError(`Invalid URL: ${address}`);
		}
		if (parsedUrl.protocol === "http:") parsedUrl.protocol = "ws:";
		else if (parsedUrl.protocol === "https:") parsedUrl.protocol = "wss:";
		websocket._url = parsedUrl.href;
		const isSecure = parsedUrl.protocol === "wss:";
		const isIpcUrl = parsedUrl.protocol === "ws+unix:";
		let invalidUrlMessage;
		if (parsedUrl.protocol !== "ws:" && !isSecure && !isIpcUrl) invalidUrlMessage = "The URL's protocol must be one of \"ws:\", \"wss:\", \"http:\", \"https:\", or \"ws+unix:\"";
		else if (isIpcUrl && !parsedUrl.pathname) invalidUrlMessage = "The URL's pathname is empty";
		else if (parsedUrl.hash) invalidUrlMessage = "The URL contains a fragment identifier";
		if (invalidUrlMessage) {
			const err = new SyntaxError(invalidUrlMessage);
			if (websocket._redirects === 0) throw err;
			else {
				emitErrorAndClose(websocket, err);
				return;
			}
		}
		const defaultPort = isSecure ? 443 : 80;
		const key = randomBytes(16).toString("base64");
		const request = isSecure ? https.request : http$1.request;
		const protocolSet = /* @__PURE__ */ new Set();
		let perMessageDeflate;
		opts.createConnection = opts.createConnection || (isSecure ? tlsConnect : netConnect);
		opts.defaultPort = opts.defaultPort || defaultPort;
		opts.port = parsedUrl.port || defaultPort;
		opts.host = parsedUrl.hostname.startsWith("[") ? parsedUrl.hostname.slice(1, -1) : parsedUrl.hostname;
		opts.headers = {
			...opts.headers,
			"Sec-WebSocket-Version": opts.protocolVersion,
			"Sec-WebSocket-Key": key,
			Connection: "Upgrade",
			Upgrade: "websocket"
		};
		opts.path = parsedUrl.pathname + parsedUrl.search;
		opts.timeout = opts.handshakeTimeout;
		if (opts.perMessageDeflate) {
			perMessageDeflate = new PerMessageDeflate$2({
				...opts.perMessageDeflate,
				isServer: false,
				maxPayload: opts.maxPayload
			});
			opts.headers["Sec-WebSocket-Extensions"] = format({ [PerMessageDeflate$2.extensionName]: perMessageDeflate.offer() });
		}
		if (protocols.length) {
			for (const protocol of protocols) {
				if (typeof protocol !== "string" || !subprotocolRegex.test(protocol) || protocolSet.has(protocol)) throw new SyntaxError("An invalid or duplicated subprotocol was specified");
				protocolSet.add(protocol);
			}
			opts.headers["Sec-WebSocket-Protocol"] = protocols.join(",");
		}
		if (opts.origin) if (opts.protocolVersion < 13) opts.headers["Sec-WebSocket-Origin"] = opts.origin;
		else opts.headers.Origin = opts.origin;
		if (parsedUrl.username || parsedUrl.password) opts.auth = `${parsedUrl.username}:${parsedUrl.password}`;
		if (isIpcUrl) {
			const parts = opts.path.split(":");
			opts.socketPath = parts[0];
			opts.path = parts[1];
		}
		let req;
		if (opts.followRedirects) {
			if (websocket._redirects === 0) {
				websocket._originalIpc = isIpcUrl;
				websocket._originalSecure = isSecure;
				websocket._originalHostOrSocketPath = isIpcUrl ? opts.socketPath : parsedUrl.host;
				const headers = options && options.headers;
				options = {
					...options,
					headers: {}
				};
				if (headers) for (const [key$1, value] of Object.entries(headers)) options.headers[key$1.toLowerCase()] = value;
			} else if (websocket.listenerCount("redirect") === 0) {
				const isSameHost = isIpcUrl ? websocket._originalIpc ? opts.socketPath === websocket._originalHostOrSocketPath : false : websocket._originalIpc ? false : parsedUrl.host === websocket._originalHostOrSocketPath;
				if (!isSameHost || websocket._originalSecure && !isSecure) {
					delete opts.headers.authorization;
					delete opts.headers.cookie;
					if (!isSameHost) delete opts.headers.host;
					opts.auth = void 0;
				}
			}
			if (opts.auth && !options.headers.authorization) options.headers.authorization = "Basic " + Buffer.from(opts.auth).toString("base64");
			req = websocket._req = request(opts);
			if (websocket._redirects) websocket.emit("redirect", websocket.url, req);
		} else req = websocket._req = request(opts);
		if (opts.timeout) req.on("timeout", () => {
			abortHandshake$1(websocket, req, "Opening handshake has timed out");
		});
		req.on("error", (err) => {
			if (req === null || req[kAborted]) return;
			req = websocket._req = null;
			emitErrorAndClose(websocket, err);
		});
		req.on("response", (res) => {
			const location = res.headers.location;
			const statusCode = res.statusCode;
			if (location && opts.followRedirects && statusCode >= 300 && statusCode < 400) {
				if (++websocket._redirects > opts.maxRedirects) {
					abortHandshake$1(websocket, req, "Maximum redirects exceeded");
					return;
				}
				req.abort();
				let addr;
				try {
					addr = new URL$1(location, address);
				} catch (e) {
					emitErrorAndClose(websocket, /* @__PURE__ */ new SyntaxError(`Invalid URL: ${location}`));
					return;
				}
				initAsClient(websocket, addr, protocols, options);
			} else if (!websocket.emit("unexpected-response", req, res)) abortHandshake$1(websocket, req, `Unexpected server response: ${res.statusCode}`);
		});
		req.on("upgrade", (res, socket, head) => {
			websocket.emit("upgrade", res);
			if (websocket.readyState !== WebSocket$3.CONNECTING) return;
			req = websocket._req = null;
			const upgrade = res.headers.upgrade;
			if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
				abortHandshake$1(websocket, socket, "Invalid Upgrade header");
				return;
			}
			const digest = createHash$1("sha1").update(key + GUID$1).digest("base64");
			if (res.headers["sec-websocket-accept"] !== digest) {
				abortHandshake$1(websocket, socket, "Invalid Sec-WebSocket-Accept header");
				return;
			}
			const serverProt = res.headers["sec-websocket-protocol"];
			let protError;
			if (serverProt !== void 0) {
				if (!protocolSet.size) protError = "Server sent a subprotocol but none was requested";
				else if (!protocolSet.has(serverProt)) protError = "Server sent an invalid subprotocol";
			} else if (protocolSet.size) protError = "Server sent no subprotocol";
			if (protError) {
				abortHandshake$1(websocket, socket, protError);
				return;
			}
			if (serverProt) websocket._protocol = serverProt;
			const secWebSocketExtensions = res.headers["sec-websocket-extensions"];
			if (secWebSocketExtensions !== void 0) {
				if (!perMessageDeflate) {
					abortHandshake$1(websocket, socket, "Server sent a Sec-WebSocket-Extensions header but no extension was requested");
					return;
				}
				let extensions;
				try {
					extensions = parse$1(secWebSocketExtensions);
				} catch (err) {
					abortHandshake$1(websocket, socket, "Invalid Sec-WebSocket-Extensions header");
					return;
				}
				const extensionNames = Object.keys(extensions);
				if (extensionNames.length !== 1 || extensionNames[0] !== PerMessageDeflate$2.extensionName) {
					abortHandshake$1(websocket, socket, "Server indicated an extension that was not requested");
					return;
				}
				try {
					perMessageDeflate.accept(extensions[PerMessageDeflate$2.extensionName]);
				} catch (err) {
					abortHandshake$1(websocket, socket, "Invalid Sec-WebSocket-Extensions header");
					return;
				}
				websocket._extensions[PerMessageDeflate$2.extensionName] = perMessageDeflate;
			}
			websocket.setSocket(socket, head, {
				allowSynchronousEvents: opts.allowSynchronousEvents,
				generateMask: opts.generateMask,
				maxBufferedChunks: opts.maxBufferedChunks,
				maxFragments: opts.maxFragments,
				maxPayload: opts.maxPayload,
				skipUTF8Validation: opts.skipUTF8Validation
			});
		});
		if (opts.finishRequest) opts.finishRequest(req, websocket);
		else req.end();
	}
	/**
	* Emit the `'error'` and `'close'` events.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {Error} The error to emit
	* @private
	*/
	function emitErrorAndClose(websocket, err) {
		websocket._readyState = WebSocket$3.CLOSING;
		websocket._errorEmitted = true;
		websocket.emit("error", err);
		websocket.emitClose();
	}
	/**
	* Create a `net.Socket` and initiate a connection.
	*
	* @param {Object} options Connection options
	* @return {net.Socket} The newly created socket used to start the connection
	* @private
	*/
	function netConnect(options) {
		options.path = options.socketPath;
		return net.connect(options);
	}
	/**
	* Create a `tls.TLSSocket` and initiate a connection.
	*
	* @param {Object} options Connection options
	* @return {tls.TLSSocket} The newly created socket used to start the connection
	* @private
	*/
	function tlsConnect(options) {
		options.path = void 0;
		if (!options.servername && options.servername !== "") options.servername = net.isIP(options.host) ? "" : options.host;
		return tls.connect(options);
	}
	/**
	* Abort the handshake and emit an error.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {(http.ClientRequest|net.Socket|tls.Socket)} stream The request to
	*     abort or the socket to destroy
	* @param {String} message The error message
	* @private
	*/
	function abortHandshake$1(websocket, stream, message) {
		websocket._readyState = WebSocket$3.CLOSING;
		const err = new Error(message);
		Error.captureStackTrace(err, abortHandshake$1);
		if (stream.setHeader) {
			stream[kAborted] = true;
			stream.abort();
			if (stream.socket && !stream.socket.destroyed) stream.socket.destroy();
			process.nextTick(emitErrorAndClose, websocket, err);
		} else {
			stream.destroy(err);
			stream.once("error", websocket.emit.bind(websocket, "error"));
			stream.once("close", websocket.emitClose.bind(websocket));
		}
	}
	/**
	* Handle cases where the `ping()`, `pong()`, or `send()` methods are called
	* when the `readyState` attribute is `CLOSING` or `CLOSED`.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @param {*} [data] The data to send
	* @param {Function} [cb] Callback
	* @private
	*/
	function sendAfterClose(websocket, data, cb) {
		if (data) {
			const length = isBlob(data) ? data.size : toBuffer(data).length;
			if (websocket._socket) websocket._sender._bufferedBytes += length;
			else websocket._bufferedAmount += length;
		}
		if (cb) {
			const err = /* @__PURE__ */ new Error(`WebSocket is not open: readyState ${websocket.readyState} (${readyStates[websocket.readyState]})`);
			process.nextTick(cb, err);
		}
	}
	/**
	* The listener of the `Receiver` `'conclude'` event.
	*
	* @param {Number} code The status code
	* @param {Buffer} reason The reason for closing
	* @private
	*/
	function receiverOnConclude(code, reason) {
		const websocket = this[kWebSocket$1];
		websocket._closeFrameReceived = true;
		websocket._closeMessage = reason;
		websocket._closeCode = code;
		if (websocket._socket[kWebSocket$1] === void 0) return;
		websocket._socket.removeListener("data", socketOnData);
		process.nextTick(resume, websocket._socket);
		if (code === 1005) websocket.close();
		else websocket.close(code, reason);
	}
	/**
	* The listener of the `Receiver` `'drain'` event.
	*
	* @private
	*/
	function receiverOnDrain() {
		const websocket = this[kWebSocket$1];
		if (!websocket.isPaused) websocket._socket.resume();
	}
	/**
	* The listener of the `Receiver` `'error'` event.
	*
	* @param {(RangeError|Error)} err The emitted error
	* @private
	*/
	function receiverOnError(err) {
		const websocket = this[kWebSocket$1];
		if (websocket._socket[kWebSocket$1] !== void 0) {
			websocket._socket.removeListener("data", socketOnData);
			process.nextTick(resume, websocket._socket);
			websocket.close(err[kStatusCode]);
		}
		if (!websocket._errorEmitted) {
			websocket._errorEmitted = true;
			websocket.emit("error", err);
		}
	}
	/**
	* The listener of the `Receiver` `'finish'` event.
	*
	* @private
	*/
	function receiverOnFinish() {
		this[kWebSocket$1].emitClose();
	}
	/**
	* The listener of the `Receiver` `'message'` event.
	*
	* @param {Buffer|ArrayBuffer|Buffer[])} data The message
	* @param {Boolean} isBinary Specifies whether the message is binary or not
	* @private
	*/
	function receiverOnMessage(data, isBinary) {
		this[kWebSocket$1].emit("message", data, isBinary);
	}
	/**
	* The listener of the `Receiver` `'ping'` event.
	*
	* @param {Buffer} data The data included in the ping frame
	* @private
	*/
	function receiverOnPing(data) {
		const websocket = this[kWebSocket$1];
		if (websocket._autoPong) websocket.pong(data, !this._isServer, NOOP);
		websocket.emit("ping", data);
	}
	/**
	* The listener of the `Receiver` `'pong'` event.
	*
	* @param {Buffer} data The data included in the pong frame
	* @private
	*/
	function receiverOnPong(data) {
		this[kWebSocket$1].emit("pong", data);
	}
	/**
	* Resume a readable stream
	*
	* @param {Readable} stream The readable stream
	* @private
	*/
	function resume(stream) {
		stream.resume();
	}
	/**
	* The `Sender` error event handler.
	*
	* @param {Error} The error
	* @private
	*/
	function senderOnError(err) {
		const websocket = this[kWebSocket$1];
		if (websocket.readyState === WebSocket$3.CLOSED) return;
		if (websocket.readyState === WebSocket$3.OPEN) {
			websocket._readyState = WebSocket$3.CLOSING;
			setCloseTimer(websocket);
		}
		this._socket.end();
		if (!websocket._errorEmitted) {
			websocket._errorEmitted = true;
			websocket.emit("error", err);
		}
	}
	/**
	* Set a timer to destroy the underlying raw socket of a WebSocket.
	*
	* @param {WebSocket} websocket The WebSocket instance
	* @private
	*/
	function setCloseTimer(websocket) {
		websocket._closeTimer = setTimeout(websocket._socket.destroy.bind(websocket._socket), websocket._closeTimeout);
	}
	/**
	* The listener of the socket `'close'` event.
	*
	* @private
	*/
	function socketOnClose() {
		const websocket = this[kWebSocket$1];
		this.removeListener("close", socketOnClose);
		this.removeListener("data", socketOnData);
		this.removeListener("end", socketOnEnd);
		websocket._readyState = WebSocket$3.CLOSING;
		if (!this._readableState.endEmitted && !websocket._closeFrameReceived && !websocket._receiver._writableState.errorEmitted && this._readableState.length !== 0) {
			const chunk = this.read(this._readableState.length);
			websocket._receiver.write(chunk);
		}
		websocket._receiver.end();
		this[kWebSocket$1] = void 0;
		clearTimeout(websocket._closeTimer);
		if (websocket._receiver._writableState.finished || websocket._receiver._writableState.errorEmitted) websocket.emitClose();
		else {
			websocket._receiver.on("error", receiverOnFinish);
			websocket._receiver.on("finish", receiverOnFinish);
		}
	}
	/**
	* The listener of the socket `'data'` event.
	*
	* @param {Buffer} chunk A chunk of data
	* @private
	*/
	function socketOnData(chunk) {
		if (!this[kWebSocket$1]._receiver.write(chunk)) this.pause();
	}
	/**
	* The listener of the socket `'end'` event.
	*
	* @private
	*/
	function socketOnEnd() {
		const websocket = this[kWebSocket$1];
		websocket._readyState = WebSocket$3.CLOSING;
		websocket._receiver.end();
		this.end();
	}
	/**
	* The listener of the socket `'error'` event.
	*
	* @private
	*/
	function socketOnError$1() {
		const websocket = this[kWebSocket$1];
		this.removeListener("error", socketOnError$1);
		this.on("error", NOOP);
		if (websocket) {
			websocket._readyState = WebSocket$3.CLOSING;
			this.destroy();
		}
	}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/stream.js
var require_stream = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/stream.js": ((exports, module) => {
	require_websocket();
	const { Duplex: Duplex$1 } = __require("stream");
	/**
	* Emits the `'close'` event on a stream.
	*
	* @param {Duplex} stream The stream.
	* @private
	*/
	function emitClose$1(stream) {
		stream.emit("close");
	}
	/**
	* The listener of the `'end'` event.
	*
	* @private
	*/
	function duplexOnEnd() {
		if (!this.destroyed && this._writableState.finished) this.destroy();
	}
	/**
	* The listener of the `'error'` event.
	*
	* @param {Error} err The error
	* @private
	*/
	function duplexOnError(err) {
		this.removeListener("error", duplexOnError);
		this.destroy();
		if (this.listenerCount("error") === 0) this.emit("error", err);
	}
	/**
	* Wraps a `WebSocket` in a duplex stream.
	*
	* @param {WebSocket} ws The `WebSocket` to wrap
	* @param {Object} [options] The options for the `Duplex` constructor
	* @return {Duplex} The duplex stream
	* @public
	*/
	function createWebSocketStream$1(ws, options) {
		let terminateOnDestroy = true;
		const duplex = new Duplex$1({
			...options,
			autoDestroy: false,
			emitClose: false,
			objectMode: false,
			writableObjectMode: false
		});
		ws.on("message", function message(msg, isBinary) {
			const data = !isBinary && duplex._readableState.objectMode ? msg.toString() : msg;
			if (!duplex.push(data)) ws.pause();
		});
		ws.once("error", function error(err) {
			if (duplex.destroyed) return;
			terminateOnDestroy = false;
			duplex.destroy(err);
		});
		ws.once("close", function close() {
			if (duplex.destroyed) return;
			duplex.push(null);
		});
		duplex._destroy = function(err, callback) {
			if (ws.readyState === ws.CLOSED) {
				callback(err);
				process.nextTick(emitClose$1, duplex);
				return;
			}
			let called = false;
			ws.once("error", function error(err$1) {
				called = true;
				callback(err$1);
			});
			ws.once("close", function close() {
				if (!called) callback(err);
				process.nextTick(emitClose$1, duplex);
			});
			if (terminateOnDestroy) ws.terminate();
		};
		duplex._final = function(callback) {
			if (ws.readyState === ws.CONNECTING) {
				ws.once("open", function open() {
					duplex._final(callback);
				});
				return;
			}
			if (ws._socket === null) return;
			if (ws._socket._writableState.finished) {
				callback();
				if (duplex._readableState.endEmitted) duplex.destroy();
			} else {
				ws._socket.once("finish", function finish() {
					callback();
				});
				ws.close();
			}
		};
		duplex._read = function() {
			if (ws.isPaused) ws.resume();
		};
		duplex._write = function(chunk, encoding, callback) {
			if (ws.readyState === ws.CONNECTING) {
				ws.once("open", function open() {
					duplex._write(chunk, encoding, callback);
				});
				return;
			}
			ws.send(chunk, callback);
		};
		duplex.on("end", duplexOnEnd);
		duplex.on("error", duplexOnError);
		return duplex;
	}
	module.exports = createWebSocketStream$1;
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/subprotocol.js
var require_subprotocol = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/subprotocol.js": ((exports, module) => {
	const { tokenChars } = require_validation();
	/**
	* Parses the `Sec-WebSocket-Protocol` header into a set of subprotocol names.
	*
	* @param {String} header The field value of the header
	* @return {Set} The subprotocol names
	* @public
	*/
	function parse(header) {
		const protocols = /* @__PURE__ */ new Set();
		let start = -1;
		let end = -1;
		let i = 0;
		for (; i < header.length; i++) {
			const code = header.charCodeAt(i);
			if (end === -1 && tokenChars[code] === 1) {
				if (start === -1) start = i;
			} else if (i !== 0 && (code === 32 || code === 9)) {
				if (end === -1 && start !== -1) end = i;
			} else if (code === 44) {
				if (start === -1) throw new SyntaxError(`Unexpected character at index ${i}`);
				if (end === -1) end = i;
				const protocol$1 = header.slice(start, end);
				if (protocols.has(protocol$1)) throw new SyntaxError(`The "${protocol$1}" subprotocol is duplicated`);
				protocols.add(protocol$1);
				start = end = -1;
			} else throw new SyntaxError(`Unexpected character at index ${i}`);
		}
		if (start === -1 || end !== -1) throw new SyntaxError("Unexpected end of input");
		const protocol = header.slice(start, i);
		if (protocols.has(protocol)) throw new SyntaxError(`The "${protocol}" subprotocol is duplicated`);
		protocols.add(protocol);
		return protocols;
	}
	module.exports = { parse };
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket-server.js
var require_websocket_server = /* @__PURE__ */ __commonJS({ "node_modules/.pnpm/ws@8.21.3/node_modules/ws/lib/websocket-server.js": ((exports, module) => {
	const EventEmitter = __require("events");
	const http = __require("http");
	const { Duplex } = __require("stream");
	const { createHash } = __require("crypto");
	const extension$1 = require_extension();
	const PerMessageDeflate$1 = require_permessage_deflate();
	const subprotocol$1 = require_subprotocol();
	const WebSocket$2 = require_websocket();
	const { CLOSE_TIMEOUT, GUID, kWebSocket } = require_constants();
	const keyRegex = /^[+/0-9A-Za-z]{22}==$/;
	const RUNNING = 0;
	const CLOSING = 1;
	const CLOSED = 2;
	/**
	* Class representing a WebSocket server.
	*
	* @extends EventEmitter
	*/
	var WebSocketServer$1 = class extends EventEmitter {
		/**
		* Create a `WebSocketServer` instance.
		*
		* @param {Object} options Configuration options
		* @param {Boolean} [options.allowSynchronousEvents=true] Specifies whether
		*     any of the `'message'`, `'ping'`, and `'pong'` events can be emitted
		*     multiple times in the same tick
		* @param {Boolean} [options.autoPong=true] Specifies whether or not to
		*     automatically send a pong in response to a ping
		* @param {Number} [options.backlog=511] The maximum length of the queue of
		*     pending connections
		* @param {Boolean} [options.clientTracking=true] Specifies whether or not to
		*     track clients
		* @param {Number} [options.closeTimeout=30000] Duration in milliseconds to
		*     wait for the closing handshake to finish after `websocket.close()` is
		*     called
		* @param {Function} [options.handleProtocols] A hook to handle protocols
		* @param {String} [options.host] The hostname where to bind the server
		* @param {Number} [options.maxBufferedChunks=262144] The maximum number of
		*     buffered data chunks
		* @param {Number} [options.maxFragments=16384] The maximum number of message
		*     fragments
		* @param {Number} [options.maxPayload=104857600] The maximum allowed message
		*     size
		* @param {Boolean} [options.noServer=false] Enable no server mode
		* @param {String} [options.path] Accept only connections matching this path
		* @param {(Boolean|Object)} [options.perMessageDeflate=false] Enable/disable
		*     permessage-deflate
		* @param {Number} [options.port] The port where to bind the server
		* @param {(http.Server|https.Server)} [options.server] A pre-created HTTP/S
		*     server to use
		* @param {Boolean} [options.skipUTF8Validation=false] Specifies whether or
		*     not to skip UTF-8 validation for text and close messages
		* @param {Function} [options.verifyClient] A hook to reject connections
		* @param {Function} [options.WebSocket=WebSocket] Specifies the `WebSocket`
		*     class to use. It must be the `WebSocket` class or class that extends it
		* @param {Function} [callback] A listener for the `listening` event
		*/
		constructor(options, callback) {
			super();
			options = {
				allowSynchronousEvents: true,
				autoPong: true,
				maxBufferedChunks: 256 * 1024,
				maxFragments: 16 * 1024,
				maxPayload: 100 * 1024 * 1024,
				skipUTF8Validation: false,
				perMessageDeflate: false,
				handleProtocols: null,
				clientTracking: true,
				closeTimeout: CLOSE_TIMEOUT,
				verifyClient: null,
				noServer: false,
				backlog: null,
				server: null,
				host: null,
				path: null,
				port: null,
				WebSocket: WebSocket$2,
				...options
			};
			if (options.port == null && !options.server && !options.noServer || options.port != null && (options.server || options.noServer) || options.server && options.noServer) throw new TypeError("One and only one of the \"port\", \"server\", or \"noServer\" options must be specified");
			if (options.port != null) {
				this._server = http.createServer((req, res) => {
					const body = http.STATUS_CODES[426];
					res.writeHead(426, {
						"Content-Length": body.length,
						"Content-Type": "text/plain"
					});
					res.end(body);
				});
				this._server.listen(options.port, options.host, options.backlog, callback);
			} else if (options.server) this._server = options.server;
			if (this._server) {
				const emitConnection = this.emit.bind(this, "connection");
				this._removeListeners = addListeners(this._server, {
					listening: this.emit.bind(this, "listening"),
					error: this.emit.bind(this, "error"),
					upgrade: (req, socket, head) => {
						this.handleUpgrade(req, socket, head, emitConnection);
					}
				});
			}
			if (options.perMessageDeflate === true) options.perMessageDeflate = {};
			if (options.clientTracking) {
				this.clients = /* @__PURE__ */ new Set();
				this._shouldEmitClose = false;
			}
			this.options = options;
			this._state = RUNNING;
		}
		/**
		* Returns the bound address, the address family name, and port of the server
		* as reported by the operating system if listening on an IP socket.
		* If the server is listening on a pipe or UNIX domain socket, the name is
		* returned as a string.
		*
		* @return {(Object|String|null)} The address of the server
		* @public
		*/
		address() {
			if (this.options.noServer) throw new Error("The server is operating in \"noServer\" mode");
			if (!this._server) return null;
			return this._server.address();
		}
		/**
		* Stop the server from accepting new connections and emit the `'close'` event
		* when all existing connections are closed.
		*
		* @param {Function} [cb] A one-time listener for the `'close'` event
		* @public
		*/
		close(cb) {
			if (this._state === CLOSED) {
				if (cb) this.once("close", () => {
					cb(/* @__PURE__ */ new Error("The server is not running"));
				});
				process.nextTick(emitClose, this);
				return;
			}
			if (cb) this.once("close", cb);
			if (this._state === CLOSING) return;
			this._state = CLOSING;
			if (this.options.noServer || this.options.server) {
				if (this._server) {
					this._removeListeners();
					this._removeListeners = this._server = null;
				}
				if (this.clients) if (!this.clients.size) process.nextTick(emitClose, this);
				else this._shouldEmitClose = true;
				else process.nextTick(emitClose, this);
			} else {
				const server = this._server;
				this._removeListeners();
				this._removeListeners = this._server = null;
				server.close(() => {
					emitClose(this);
				});
			}
		}
		/**
		* See if a given request should be handled by this server instance.
		*
		* @param {http.IncomingMessage} req Request object to inspect
		* @return {Boolean} `true` if the request is valid, else `false`
		* @public
		*/
		shouldHandle(req) {
			if (this.options.path) {
				const index = req.url.indexOf("?");
				if ((index !== -1 ? req.url.slice(0, index) : req.url) !== this.options.path) return false;
			}
			return true;
		}
		/**
		* Handle a HTTP Upgrade request.
		*
		* @param {http.IncomingMessage} req The request object
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Function} cb Callback
		* @public
		*/
		handleUpgrade(req, socket, head, cb) {
			socket.on("error", socketOnError);
			const key = req.headers["sec-websocket-key"];
			const upgrade = req.headers.upgrade;
			const version = +req.headers["sec-websocket-version"];
			if (req.method !== "GET") {
				abortHandshakeOrEmitwsClientError(this, req, socket, 405, "Invalid HTTP method");
				return;
			}
			if (upgrade === void 0 || upgrade.toLowerCase() !== "websocket") {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid Upgrade header");
				return;
			}
			if (key === void 0 || !keyRegex.test(key)) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Missing or invalid Sec-WebSocket-Key header");
				return;
			}
			if (version !== 13 && version !== 8) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Missing or invalid Sec-WebSocket-Version header", { "Sec-WebSocket-Version": "13, 8" });
				return;
			}
			if (!this.shouldHandle(req)) {
				abortHandshake(socket, 400);
				return;
			}
			const secWebSocketProtocol = req.headers["sec-websocket-protocol"];
			let protocols = /* @__PURE__ */ new Set();
			if (secWebSocketProtocol !== void 0) try {
				protocols = subprotocol$1.parse(secWebSocketProtocol);
			} catch (err) {
				abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid Sec-WebSocket-Protocol header");
				return;
			}
			const secWebSocketExtensions = req.headers["sec-websocket-extensions"];
			const extensions = {};
			if (this.options.perMessageDeflate && secWebSocketExtensions !== void 0) {
				const perMessageDeflate = new PerMessageDeflate$1({
					...this.options.perMessageDeflate,
					isServer: true,
					maxPayload: this.options.maxPayload
				});
				try {
					const offers = extension$1.parse(secWebSocketExtensions);
					if (offers[PerMessageDeflate$1.extensionName]) {
						perMessageDeflate.accept(offers[PerMessageDeflate$1.extensionName]);
						extensions[PerMessageDeflate$1.extensionName] = perMessageDeflate;
					}
				} catch (err) {
					abortHandshakeOrEmitwsClientError(this, req, socket, 400, "Invalid or unacceptable Sec-WebSocket-Extensions header");
					return;
				}
			}
			if (this.options.verifyClient) {
				const info = {
					origin: req.headers[`${version === 8 ? "sec-websocket-origin" : "origin"}`],
					secure: !!(req.socket.authorized || req.socket.encrypted),
					req
				};
				if (this.options.verifyClient.length === 2) {
					this.options.verifyClient(info, (verified, code, message, headers) => {
						if (!verified) return abortHandshake(socket, code || 401, message, headers);
						this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
					});
					return;
				}
				if (!this.options.verifyClient(info)) return abortHandshake(socket, 401);
			}
			this.completeUpgrade(extensions, key, protocols, req, socket, head, cb);
		}
		/**
		* Upgrade the connection to WebSocket.
		*
		* @param {Object} extensions The accepted extensions
		* @param {String} key The value of the `Sec-WebSocket-Key` header
		* @param {Set} protocols The subprotocols
		* @param {http.IncomingMessage} req The request object
		* @param {Duplex} socket The network socket between the server and client
		* @param {Buffer} head The first packet of the upgraded stream
		* @param {Function} cb Callback
		* @throws {Error} If called more than once with the same socket
		* @private
		*/
		completeUpgrade(extensions, key, protocols, req, socket, head, cb) {
			if (!socket.readable || !socket.writable) return socket.destroy();
			if (socket[kWebSocket]) throw new Error("server.handleUpgrade() was called more than once with the same socket, possibly due to a misconfiguration");
			if (this._state > RUNNING) return abortHandshake(socket, 503);
			const headers = [
				"HTTP/1.1 101 Switching Protocols",
				"Upgrade: websocket",
				"Connection: Upgrade",
				`Sec-WebSocket-Accept: ${createHash("sha1").update(key + GUID).digest("base64")}`
			];
			const ws = new this.options.WebSocket(null, void 0, this.options);
			if (protocols.size) {
				const protocol = this.options.handleProtocols ? this.options.handleProtocols(protocols, req) : protocols.values().next().value;
				if (protocol) {
					headers.push(`Sec-WebSocket-Protocol: ${protocol}`);
					ws._protocol = protocol;
				}
			}
			if (extensions[PerMessageDeflate$1.extensionName]) {
				const params = extensions[PerMessageDeflate$1.extensionName].params;
				const value = extension$1.format({ [PerMessageDeflate$1.extensionName]: [params] });
				headers.push(`Sec-WebSocket-Extensions: ${value}`);
				ws._extensions = extensions;
			}
			this.emit("headers", headers, req);
			socket.write(headers.concat("\r\n").join("\r\n"));
			socket.removeListener("error", socketOnError);
			ws.setSocket(socket, head, {
				allowSynchronousEvents: this.options.allowSynchronousEvents,
				maxBufferedChunks: this.options.maxBufferedChunks,
				maxFragments: this.options.maxFragments,
				maxPayload: this.options.maxPayload,
				skipUTF8Validation: this.options.skipUTF8Validation
			});
			if (this.clients) {
				this.clients.add(ws);
				ws.on("close", () => {
					this.clients.delete(ws);
					if (this._shouldEmitClose && !this.clients.size) process.nextTick(emitClose, this);
				});
			}
			cb(ws, req);
		}
	};
	module.exports = WebSocketServer$1;
	/**
	* Add event listeners on an `EventEmitter` using a map of <event, listener>
	* pairs.
	*
	* @param {EventEmitter} server The event emitter
	* @param {Object.<String, Function>} map The listeners to add
	* @return {Function} A function that will remove the added listeners when
	*     called
	* @private
	*/
	function addListeners(server, map) {
		for (const event of Object.keys(map)) server.on(event, map[event]);
		return function removeListeners() {
			for (const event of Object.keys(map)) server.removeListener(event, map[event]);
		};
	}
	/**
	* Emit a `'close'` event on an `EventEmitter`.
	*
	* @param {EventEmitter} server The event emitter
	* @private
	*/
	function emitClose(server) {
		server._state = CLOSED;
		server.emit("close");
	}
	/**
	* Handle socket errors.
	*
	* @private
	*/
	function socketOnError() {
		this.destroy();
	}
	/**
	* Close the connection when preconditions are not fulfilled.
	*
	* @param {Duplex} socket The socket of the upgrade request
	* @param {Number} code The HTTP response status code
	* @param {String} [message] The HTTP response body
	* @param {Object} [headers] Additional HTTP response headers
	* @private
	*/
	function abortHandshake(socket, code, message, headers) {
		message = message || http.STATUS_CODES[code];
		headers = {
			Connection: "close",
			"Content-Type": "text/html",
			"Content-Length": Buffer.byteLength(message),
			...headers
		};
		socket.once("finish", socket.destroy);
		socket.end(`HTTP/1.1 ${code} ${http.STATUS_CODES[code]}\r\n` + Object.keys(headers).map((h) => `${h}: ${headers[h]}`).join("\r\n") + "\r\n\r\n" + message);
	}
	/**
	* Emit a `'wsClientError'` event on a `WebSocketServer` if there is at least
	* one listener for it, otherwise call `abortHandshake()`.
	*
	* @param {WebSocketServer} server The WebSocket server
	* @param {http.IncomingMessage} req The request object
	* @param {Duplex} socket The socket of the upgrade request
	* @param {Number} code The HTTP response status code
	* @param {String} message The HTTP response body
	* @param {Object} [headers] The HTTP response headers
	* @private
	*/
	function abortHandshakeOrEmitwsClientError(server, req, socket, code, message, headers) {
		if (server.listenerCount("wsClientError")) {
			const err = new Error(message);
			Error.captureStackTrace(err, abortHandshakeOrEmitwsClientError);
			server.emit("wsClientError", err, socket, req);
		} else abortHandshake(socket, code, message, headers);
	}
}) });

//#endregion
//#region node_modules/.pnpm/ws@8.21.3/node_modules/ws/wrapper.mjs
var import_stream = /* @__PURE__ */ __toESM(require_stream(), 1);
var import_extension = /* @__PURE__ */ __toESM(require_extension(), 1);
var import_permessage_deflate = /* @__PURE__ */ __toESM(require_permessage_deflate(), 1);
var import_receiver = /* @__PURE__ */ __toESM(require_receiver(), 1);
var import_sender = /* @__PURE__ */ __toESM(require_sender(), 1);
var import_subprotocol = /* @__PURE__ */ __toESM(require_subprotocol(), 1);
var import_websocket = /* @__PURE__ */ __toESM(require_websocket(), 1);
var import_websocket_server = /* @__PURE__ */ __toESM(require_websocket_server(), 1);

//#endregion
//#region src/worker/cdp-client.ts
var CdpClient = class {
	ws;
	nextId;
	pending;
	events;
	constructor(ws) {
		this.ws = ws;
		this.nextId = 0;
		this.pending = /* @__PURE__ */ new Map();
		this.events = /* @__PURE__ */ new Map();
		ws.addEventListener("message", (event) => this.#handleMessage(event));
		const close = () => this.#rejectPending(/* @__PURE__ */ new Error("CDP connection closed"));
		ws.addEventListener("close", close, { once: true });
		ws.addEventListener("error", close, { once: true });
	}
	#handleMessage(event) {
		let message;
		try {
			message = JSON.parse(typeof event.data === "string" ? event.data : String(event.data));
		} catch {
			return;
		}
		if (message.id && this.pending.has(message.id)) {
			const pending = this.pending.get(message.id);
			this.pending.delete(message.id);
			clearTimeout(pending.timer);
			if (message.error) {
				const error = new Error(message.error.message || `CDP error ${message.error.code}`);
				error.code = message.error.code;
				error.data = message.error.data;
				pending.reject(error);
			} else pending.resolve(message.result || {});
			return;
		}
		if (!message.method) return;
		for (const handler of this.events.get(message.method) || []) try {
			handler(message.params || {}, message.sessionId);
		} catch {}
	}
	#rejectPending(error) {
		for (const pending of this.pending.values()) {
			clearTimeout(pending.timer);
			pending.reject(error);
		}
		this.pending.clear();
	}
	call(method, params = {}, sessionId, timeoutMs = 6e3) {
		const id = ++this.nextId;
		const payload = {
			id,
			method,
			params
		};
		if (sessionId) payload.sessionId = sessionId;
		return new Promise((resolve, reject) => {
			const timer = setTimeout(() => {
				this.pending.delete(id);
				reject(/* @__PURE__ */ new Error(`CDP ${method} timed out after ${timeoutMs}ms`));
			}, timeoutMs);
			this.pending.set(id, {
				resolve,
				reject,
				timer
			});
			try {
				this.ws.send(JSON.stringify(payload));
			} catch (error) {
				clearTimeout(timer);
				this.pending.delete(id);
				reject(error);
			}
		});
	}
	on(method, handler) {
		if (!this.events.has(method)) this.events.set(method, /* @__PURE__ */ new Set());
		this.events.get(method).add(handler);
		return () => {
			this.events.get(method)?.delete(handler);
		};
	}
};

//#endregion
//#region src/worker/capture-cdp.ts
var TargetSessions = class {
	cdp;
	sessions;
	detachDestroyed;
	destroyedHandlers;
	constructor(cdp) {
		this.cdp = cdp;
		this.sessions = /* @__PURE__ */ new Map();
		this.detachDestroyed = cdp.on("Target.targetDestroyed", (params) => {
			const { targetId } = params;
			if (!targetId) return;
			this.sessions.delete(targetId);
			for (const handler of this.destroyedHandlers || []) handler(targetId);
		});
		this.destroyedHandlers = /* @__PURE__ */ new Set();
	}
	async ensure(targetId) {
		if (this.sessions.has(targetId)) return this.sessions.get(targetId);
		const result = await this.cdp.call("Target.attachToTarget", {
			targetId,
			flatten: true
		});
		if (!result.sessionId) throw new Error(`CDP did not return a session for ${targetId}`);
		const session = {
			targetId,
			sessionId: result.sessionId,
			viewportW: null,
			viewportH: null
		};
		this.sessions.set(targetId, session);
		await Promise.allSettled([this.cdp.call("Page.enable", {}, session.sessionId), this.cdp.call("Runtime.enable", {}, session.sessionId)]);
		await this.updateViewport(targetId);
		return session;
	}
	get(targetId) {
		return this.sessions.get(targetId) || null;
	}
	onDestroyed(handler) {
		this.destroyedHandlers.add(handler);
		return () => {
			this.destroyedHandlers.delete(handler);
		};
	}
	async updateViewport(targetId) {
		const session = await this.ensure(targetId);
		try {
			const result = await this.cdp.call("Page.getLayoutMetrics", {}, session.sessionId);
			const viewport = result.cssLayoutViewport || result.cssViewport || {};
			if (Number.isFinite(viewport.clientWidth ?? viewport.width)) session.viewportW = viewport.clientWidth ?? viewport.width;
			if (Number.isFinite(viewport.clientHeight ?? viewport.height)) session.viewportH = viewport.clientHeight ?? viewport.height;
		} catch {}
		return session;
	}
	async call(targetId, method, params = {}, timeoutMs = 6e3) {
		const session = await this.ensure(targetId);
		return this.cdp.call(method, params, session.sessionId, timeoutMs);
	}
	async sendInput(targetId, payload) {
		const { type, x, y, button = "left", buttons = 0, deltaX = 0, deltaY = 0, clickCount = 0, modifiers = 0 } = payload || {};
		if (type === "mouseMoved") await this.call(targetId, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			buttons
		});
		else if (type === "mousePressed" || type === "mouseReleased") await this.call(targetId, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			button,
			buttons,
			clickCount,
			modifiers
		});
		else if (type === "mouseWheel") await this.call(targetId, "Input.dispatchMouseEvent", {
			type,
			x,
			y,
			deltaX,
			deltaY
		});
		else if (type === "insertText") {
			const text = typeof payload?.text === "string" ? payload.text : "";
			if (text === "" || text.length > 1e4) return {
				ok: false,
				error: "text must contain 1-10000 characters"
			};
			await this.call(targetId, "Input.insertText", { text });
		} else if (type === "keyDown" || type === "keyUp") {
			const key = typeof payload?.key === "string" ? payload.key.slice(0, 64) : "";
			const code = typeof payload?.code === "string" ? payload.code.slice(0, 64) : "";
			if (!key) return {
				ok: false,
				error: "key is required"
			};
			const virtualKeyCode = Number.isInteger(payload.windowsVirtualKeyCode) ? payload.windowsVirtualKeyCode : 0;
			await this.call(targetId, "Input.dispatchKeyEvent", {
				type,
				key,
				code,
				modifiers,
				autoRepeat: !!payload.autoRepeat,
				windowsVirtualKeyCode: virtualKeyCode,
				nativeVirtualKeyCode: virtualKeyCode,
				...type === "keyDown" && key === "Enter" ? {
					text: "\r",
					unmodifiedText: "\r"
				} : {}
			});
		} else return {
			ok: false,
			error: `unsupported input type: ${type}`
		};
		return { ok: true };
	}
	async dispose() {
		this.detachDestroyed?.();
		const current = [...this.sessions.values()];
		this.sessions.clear();
		await Promise.allSettled(current.map((session) => this.cdp.call("Target.detachFromTarget", { sessionId: session.sessionId })));
	}
};
var CdpCaptureBackend = class {
	cdp;
	sessions;
	getConfig;
	onStatus;
	onJpegFrame;
	now;
	setTimer;
	clearTimer;
	current;
	pendingFrame;
	sendTimer;
	backstopTimer;
	lastSentAt;
	metrics;
	offFrame;
	offDestroyed;
	constructor({ cdp, sessions, getConfig, onStatus, onJpegFrame, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout }) {
		this.cdp = cdp;
		this.sessions = sessions;
		this.getConfig = getConfig;
		this.onStatus = onStatus;
		this.onJpegFrame = onJpegFrame;
		this.now = now;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		this.current = null;
		this.pendingFrame = null;
		this.sendTimer = null;
		this.backstopTimer = null;
		this.lastSentAt = 0;
		this.metrics = {
			sourceFrames: 0,
			sentFrames: 0,
			droppedFrames: 0,
			ackErrors: 0
		};
		this.offFrame = cdp.on("Page.screencastFrame", (params, targetSessionId) => this.#onFrame(params, targetSessionId));
		this.offDestroyed = sessions.onDestroyed?.((targetId) => {
			if (this.current?.targetId !== targetId) return;
			this.stop("target-destroyed").then(() => this.onStatus({
				backend: "cdp",
				state: "failed",
				targetId,
				code: "capture-target-destroyed",
				message: "The watched target was closed"
			})).catch(() => {});
		});
	}
	async start({ targetId }) {
		await this.stop("restart");
		const session = await this.sessions.ensure(targetId);
		const config = this.getConfig();
		this.current = {
			targetId,
			sessionId: session.sessionId,
			lastFrameAt: 0,
			startedAt: this.now()
		};
		this.onStatus({
			backend: "cdp",
			state: "starting",
			targetId
		});
		try {
			await this.cdp.call("Page.startScreencast", {
				format: "jpeg",
				quality: config.cdpQuality,
				maxWidth: config.cdpMaxWidth,
				everyNthFrame: 1
			}, session.sessionId);
			this.onStatus({
				backend: "cdp",
				state: "streaming",
				targetId,
				metrics: this.metrics
			});
			this.#scheduleBackstop();
		} catch (error) {
			this.current = null;
			this.onStatus({
				backend: "cdp",
				state: "failed",
				targetId,
				code: "cdp-start-failed",
				message: error.message
			});
			throw error;
		}
	}
	async switchTarget({ targetId }) {
		this.onStatus({
			backend: "cdp",
			state: "switching",
			targetId
		});
		await this.start({ targetId });
	}
	async updateConfig() {
		if (this.current) await this.start({ targetId: this.current.targetId });
	}
	async stop(reason = "stopped") {
		this.clearTimer(this.sendTimer);
		this.clearTimer(this.backstopTimer);
		this.sendTimer = null;
		this.backstopTimer = null;
		this.pendingFrame = null;
		const current = this.current;
		this.current = null;
		if (current) {
			await this.cdp.call("Page.stopScreencast", {}, current.sessionId).catch(() => {});
			this.onStatus({
				backend: "cdp",
				state: "idle",
				targetId: null,
				message: reason,
				metrics: this.metrics
			});
		}
	}
	status() {
		return {
			backend: "cdp",
			state: this.current ? "streaming" : "idle",
			targetId: this.current?.targetId || null,
			metrics: { ...this.metrics }
		};
	}
	dispose() {
		this.offFrame?.();
		this.offFrame = null;
		this.offDestroyed?.();
		this.offDestroyed = null;
	}
	async #onFrame(params, targetSessionId) {
		const current = this.current;
		if (!current || current.sessionId !== targetSessionId) return;
		this.metrics.sourceFrames += 1;
		if (params.sessionId === void 0 || params.sessionId === null) this.metrics.ackErrors += 1;
		else this.cdp.call("Page.screencastFrameAck", { sessionId: params.sessionId }, targetSessionId).catch((error) => {
			this.metrics.ackErrors += 1;
			this.onStatus({
				backend: "cdp",
				state: "streaming",
				targetId: current.targetId,
				code: "cdp-ack-failed",
				message: error.message,
				metrics: this.metrics
			});
		});
		if (!params.data) return;
		const metadata = params.metadata || {};
		const session = this.sessions.get(current.targetId);
		if (session) {
			if (Number.isFinite(metadata.visibleViewportWidth)) session.viewportW = metadata.visibleViewportWidth;
			if (Number.isFinite(metadata.visibleViewportHeight)) session.viewportH = metadata.visibleViewportHeight;
		}
		this.pendingFrame = {
			targetId: current.targetId,
			data: params.data,
			vw: session?.viewportW || null,
			vh: session?.viewportH || null,
			ts: this.now()
		};
		current.lastFrameAt = this.now();
		const minGap = 1e3 / this.getConfig().cdpFps;
		const delay = Math.max(0, minGap - (this.now() - (this.lastSentAt || 0)));
		if (delay === 0) this.#flushLatest();
		else if (!this.sendTimer) this.sendTimer = this.setTimer(() => this.#flushLatest(), delay);
		if (delay > 0) this.metrics.droppedFrames += 1;
	}
	#flushLatest() {
		this.sendTimer = null;
		const frame = this.pendingFrame;
		this.pendingFrame = null;
		if (!frame || !this.current || frame.targetId !== this.current.targetId) return;
		this.lastSentAt = this.now();
		this.metrics.sentFrames += 1;
		this.onJpegFrame(frame);
	}
	#scheduleBackstop() {
		this.clearTimer(this.backstopTimer);
		const interval = this.getConfig().cdpBackstopIntervalMs;
		this.backstopTimer = this.setTimer(async () => {
			const current = this.current;
			if (!current) return;
			if (this.now() - current.lastFrameAt >= interval) try {
				const session = await this.sessions.updateViewport(current.targetId);
				const scale = session.viewportW > this.getConfig().cdpMaxWidth ? this.getConfig().cdpMaxWidth / session.viewportW : 1;
				const result = await this.cdp.call("Page.captureScreenshot", {
					format: "jpeg",
					quality: this.getConfig().cdpQuality,
					captureBeyondViewport: false,
					...session.viewportW && session.viewportH ? { clip: {
						x: 0,
						y: 0,
						width: session.viewportW,
						height: session.viewportH,
						scale
					} } : {}
				}, current.sessionId);
				if (result.data) this.onJpegFrame({
					targetId: current.targetId,
					data: result.data,
					vw: session.viewportW,
					vh: session.viewportH,
					ts: this.now(),
					backstop: true
				});
			} catch {}
			this.#scheduleBackstop();
		}, interval);
	}
};

//#endregion
//#region src/worker/capture-manager.ts
var CaptureManager = class {
	backendFactories;
	getConfig;
	onStatus;
	now;
	setTimer;
	clearTimer;
	leaseTtlMs;
	idleGraceMs;
	leases;
	backend;
	backendName;
	targetId;
	generation;
	statusValue;
	transition;
	stopTimer;
	sweepTimer;
	constructor({ backendFactories, getConfig, onStatus, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout, leaseTtlMs = 12e4, idleGraceMs = 1500 }) {
		this.backendFactories = backendFactories;
		this.getConfig = getConfig;
		this.onStatus = onStatus;
		this.now = now;
		this.setTimer = setTimer;
		this.clearTimer = clearTimer;
		this.leaseTtlMs = leaseTtlMs;
		this.idleGraceMs = idleGraceMs;
		this.leases = /* @__PURE__ */ new Map();
		this.backend = null;
		this.backendName = null;
		this.targetId = null;
		this.generation = 0;
		const fallbackReason = this.getConfig().ffmpegFallbackReason;
		this.statusValue = {
			backend: this.#resolvedBackend(),
			state: "idle",
			targetId: null,
			generation: 0,
			...fallbackReason ? {
				code: "ffmpeg-fallback-cdp",
				message: fallbackReason
			} : {}
		};
		this.transition = Promise.resolve();
		this.stopTimer = null;
		this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5e3, this.leaseTtlMs));
	}
	#resolvedBackend(requested) {
		const value = requested || this.getConfig().captureBackend;
		return value === "auto" ? "cdp" : value;
	}
	async startWatch({ clientId, backend, targetId }) {
		if (!clientId || !targetId) throw new Error("clientId and targetId are required");
		this.clearTimer(this.stopTimer);
		this.stopTimer = null;
		const requestedBackend = backend || this.getConfig().captureBackend;
		const existing = this.leases.get(clientId);
		this.leases.set(clientId, {
			clientId,
			backend: requestedBackend,
			targetId,
			expiresAt: this.now() + this.leaseTtlMs
		});
		if (existing && existing.backend === requestedBackend && existing.targetId === targetId) {
			const resolved = this.#resolvedBackend(requestedBackend);
			if (this.targetId !== targetId || this.backendName && this.backendName !== resolved) return this.status();
			if (this.backend && this.backendName === resolved) return this.status();
		}
		return this.#enqueue(async () => {
			await this.#activate(this.#resolvedBackend(backend), targetId);
			return this.status();
		});
	}
	async switchWatch({ clientId, targetId }) {
		const lease = this.leases.get(clientId);
		if (!lease) throw new Error("watch lease not found");
		lease.targetId = targetId;
		lease.expiresAt = this.now() + this.leaseTtlMs;
		return this.#enqueue(async () => {
			await this.#activate(this.#resolvedBackend(lease.backend), targetId);
			return this.status();
		});
	}
	async stopWatch({ clientId }) {
		this.leases.delete(clientId);
		if (this.leases.size === 0 && !this.stopTimer) this.stopTimer = this.setTimer(() => {
			this.stopTimer = null;
			if (this.leases.size === 0) this.stop("no-watchers").catch(() => {});
		}, this.idleGraceMs);
		return this.status();
	}
	async updateConfig() {
		const desired = this.#resolvedBackend();
		if (!this.backend) {
			const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
			if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId, true));
			const fallbackReason = this.getConfig().ffmpegFallbackReason;
			this.#setStatus({
				backend: desired,
				state: "idle",
				targetId: null,
				code: fallbackReason ? "ffmpeg-fallback-cdp" : null,
				message: fallbackReason || "config-updated"
			});
			return;
		}
		return this.#enqueue(() => this.#activate(desired, this.targetId, true));
	}
	async browserDisconnected() {
		return this.#enqueue(async () => {
			await this.#stopBackend("browser-disconnected");
			this.#setStatus({
				backend: this.#resolvedBackend(),
				state: "failed",
				targetId: null,
				code: "browser-disconnected",
				message: "Browser disconnected"
			});
		});
	}
	async browserConnected() {
		const lease = [...this.leases.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
		if (lease) return this.#enqueue(() => this.#activate(this.#resolvedBackend(lease.backend), lease.targetId));
	}
	async #activate(backendName, targetId, force = false) {
		if (!force && this.backend && this.backendName === backendName && this.targetId === targetId) return;
		await this.#stopBackend("backend-change");
		const factory = this.backendFactories[backendName];
		if (!factory) {
			const message = `${backendName} backend is unavailable`;
			this.#setStatus({
				backend: backendName,
				state: "failed",
				targetId,
				code: "capture-backend-unavailable",
				message
			});
			if (backendName === "ffmpeg" && this.backendFactories.cdp) {
				await this.#activate("cdp", targetId, true);
				if (this.backend && this.backendName === "cdp") this.#setStatus({
					backend: "cdp",
					code: "ffmpeg-fallback-cdp",
					message: `FFmpeg unavailable; using CDP: ${message}`
				});
			}
			return;
		}
		try {
			this.backendName = backendName;
			this.targetId = targetId;
			this.generation += 1;
			const generation = this.generation;
			const fallbackReason = backendName === "cdp" ? this.getConfig().ffmpegFallbackReason : null;
			this.#setStatus({
				backend: backendName,
				state: "starting",
				targetId,
				generation,
				code: fallbackReason ? "ffmpeg-fallback-cdp" : null,
				message: fallbackReason || null
			});
			let candidate;
			candidate = factory({
				generation,
				onStatus: (status) => {
					if (this.backend !== candidate || this.generation !== generation) return;
					this.#setStatus({
						...status,
						generation
					});
				}
			});
			this.backend = candidate;
			await candidate.start({
				targetId,
				generation
			});
		} catch (error) {
			const e = error;
			const failed = this.backend;
			this.backend = null;
			if (failed) {
				await failed.stop?.("start-failed").catch(() => {});
				await Promise.resolve(failed.dispose?.()).catch(() => {});
			}
			this.#setStatus({
				backend: backendName,
				state: "failed",
				targetId,
				generation: this.generation,
				code: e.code,
				message: e.message
			});
			if (backendName === "ffmpeg" && this.backendFactories.cdp) {
				await this.#activate("cdp", targetId, true);
				if (this.backend && this.backendName === "cdp") this.#setStatus({
					backend: "cdp",
					code: "ffmpeg-fallback-cdp",
					message: `FFmpeg unavailable; using CDP: ${e.message}`
				});
			}
		}
	}
	async #stopBackend(reason = "stopped") {
		const backend = this.backend;
		this.backend = null;
		this.backendName = null;
		this.targetId = null;
		if (backend) {
			await backend.stop(reason);
			await backend.dispose?.();
		}
		this.#setStatus({
			backend: this.#resolvedBackend(),
			state: "idle",
			targetId: null,
			generation: this.generation,
			message: reason
		});
	}
	stop(reason = "stopped") {
		return this.#enqueue(() => this.#stopBackend(reason));
	}
	#enqueue(work) {
		const run = this.transition.then(work, work);
		this.transition = run.catch(() => {});
		return run;
	}
	status() {
		return {
			...this.statusValue,
			watchers: this.leases.size
		};
	}
	#setStatus(status) {
		this.statusValue = {
			...this.statusValue,
			...status
		};
		this.onStatus(this.status());
	}
	#sweep() {
		const now = this.now();
		for (const [clientId, lease] of this.leases) if (lease.expiresAt <= now) this.leases.delete(clientId);
		if (this.leases.size === 0 && this.backend) this.stop("lease-expired").catch(() => {});
		this.sweepTimer = this.setTimer(() => this.#sweep(), Math.min(5e3, this.leaseTtlMs));
	}
	async dispose() {
		this.clearTimer(this.stopTimer);
		this.clearTimer(this.sweepTimer);
		this.leases.clear();
		await this.stop("disposed");
	}
};

//#endregion
//#region src/worker/mp4-fragments.ts
const MAX_BOX_BYTES = 64 * 1024 * 1024;
var Mp4FragmentParser = class {
	onInit;
	onFragment;
	maxBoxBytes;
	buffer;
	initBoxes;
	fragmentBoxes;
	ready;
	constructor({ onInit, onFragment, maxBoxBytes = MAX_BOX_BYTES }) {
		this.onInit = onInit;
		this.onFragment = onFragment;
		this.maxBoxBytes = maxBoxBytes;
		this.buffer = Buffer.alloc(0);
		this.initBoxes = [];
		this.fragmentBoxes = [];
		this.ready = false;
	}
	push(chunk) {
		this.buffer = Buffer.concat([this.buffer, Buffer.from(chunk)]);
		while (this.buffer.length >= 8) {
			const size = this.buffer.readUInt32BE(0);
			const type = this.buffer.toString("ascii", 4, 8);
			if (size === 1) throw new Error("64-bit MP4 boxes are not supported");
			if (size < 8 || size > this.maxBoxBytes) throw new Error(`invalid MP4 box size ${size}`);
			if (this.buffer.length < size) return;
			const box = this.buffer.subarray(0, size);
			this.buffer = this.buffer.subarray(size);
			this.#box(type, box);
		}
	}
	end() {
		if (this.buffer.length !== 0) throw new Error("truncated MP4 stream");
	}
	#box(type, box) {
		if (!this.ready) {
			if (type !== "ftyp" && type !== "moov") throw new Error(`unexpected MP4 init box ${type}`);
			this.initBoxes.push(box);
			if (type === "moov") {
				this.ready = true;
				this.onInit(Buffer.concat(this.initBoxes));
				this.initBoxes = [];
			}
			return;
		}
		if (type === "moof") {
			this.fragmentBoxes = [box];
			return;
		}
		if (type === "mdat" && this.fragmentBoxes.length) {
			this.fragmentBoxes.push(box);
			this.onFragment(Buffer.concat(this.fragmentBoxes));
			this.fragmentBoxes = [];
			return;
		}
		if (type !== "free" && type !== "sidx") throw new Error(`unexpected MP4 media box ${type}`);
	}
};

//#endregion
//#region src/worker/capture-platform.ts
const execFile$1 = promisify(execFile);
function buildCaptureInput({ platform: platform$1 = process.platform, env = process.env, source, fps, maxWidth, encoder }) {
	if (platform$1 === "win32") {
		if (source.sourceType !== "window-hwnd" || !source.hwnd) {
			const error = /* @__PURE__ */ new Error("Windows FFmpeg capture requires a Chrome window handle");
			error.code = "ffmpeg-window-hwnd-missing";
			throw error;
		}
		const outputWidth = Math.max(2, Math.floor(Math.min(maxWidth, source.captureWidth) / 2) * 2);
		const outputHeight = Math.max(2, Math.floor(source.captureHeight * outputWidth / source.captureWidth / 2) * 2);
		const filters = [
			`gfxcapture=${[
				`hwnd=${source.hwnd}`,
				`max_framerate=${fps}`,
				"capture_cursor=false",
				"capture_border=false",
				"display_border=false",
				`crop_left=${source.cropLeft || 0}`,
				`crop_top=${source.cropTop || 0}`,
				`crop_right=${source.cropRight || 0}`,
				`crop_bottom=${source.cropBottom || 0}`,
				`width=${outputWidth}`,
				`height=${outputHeight}`,
				"resize_mode=scale_aspect"
			].join(":")}`,
			`fps=${fps}`,
			`setpts=N/(${fps}*TB)`
		];
		if (encoder === "libx264") filters.push("hwdownload", "format=bgra", "format=yuv420p");
		return ["-filter_complex", filters.join(",")];
	}
	if (platform$1 === "darwin") return [
		"-f",
		"avfoundation",
		"-framerate",
		String(fps),
		"-i",
		`${source.displayIndex || 1}:none`
	];
	if (env.XDG_SESSION_TYPE === "wayland" || env.WAYLAND_DISPLAY) {
		const error = /* @__PURE__ */ new Error("The bundled FFmpeg does not provide a guaranteed Wayland Portal capture input");
		error.code = "unsupported-ffmpeg-pipewire";
		throw error;
	}
	const display = env.DISPLAY || ":0";
	return [
		"-f",
		"x11grab",
		"-framerate",
		String(fps),
		"-video_size",
		`${source.captureWidth}x${source.captureHeight}`,
		"-i",
		`${display}+${source.captureX},${source.captureY}`
	];
}
function buildEncoderArgs({ encoder, fps, maxWidth, bitrateKbps = 4e3, source, platform: platform$1 = process.platform }) {
	const maxrateKbps = Math.round(bitrateKbps * 1.25);
	const bufsizeKbps = bitrateKbps * 2;
	const rateArgs = [
		"-b:v",
		`${bitrateKbps}k`,
		"-maxrate",
		`${maxrateKbps}k`,
		"-bufsize",
		`${bufsizeKbps}k`
	];
	if (platform$1 === "win32" && source?.sourceType === "window-hwnd") {
		const common$1 = [
			"-an",
			"-g",
			String(fps),
			"-bf",
			"0",
			...rateArgs
		];
		if (encoder === "h264_mf") common$1.push("-c:v", encoder, "-hw_encoding", "1", "-scenario", "display_remoting", "-rate_control", "ld_vbr");
		else if (encoder === "libx264") common$1.push("-c:v", encoder, "-preset", "ultrafast", "-tune", "zerolatency", "-profile:v", "baseline", "-pix_fmt", "yuv420p");
		else common$1.push("-c:v", encoder);
		return [
			...common$1,
			"-movflags",
			"empty_moov+default_base_moof+frag_keyframe+skip_trailer",
			"-frag_duration",
			"100000",
			"-f",
			"mp4",
			"pipe:1"
		];
	}
	const filters = [];
	if (platform$1 === "darwin" && source) filters.push(`crop=${source.captureWidth}:${source.captureHeight}:${source.captureX}:${source.captureY}`);
	filters.push(`scale='min(${maxWidth},iw)':-2`);
	const common = [
		"-an",
		"-vf",
		filters.join(","),
		"-pix_fmt",
		"yuv420p",
		"-g",
		String(fps),
		"-keyint_min",
		String(fps),
		"-sc_threshold",
		"0",
		"-bf",
		"0",
		"-profile:v",
		"baseline",
		...rateArgs
	];
	if (encoder === "libx264") common.push("-c:v", "libx264", "-preset", "ultrafast", "-tune", "zerolatency");
	else common.push("-c:v", encoder);
	return [
		...common,
		"-movflags",
		"empty_moov+default_base_moof+frag_keyframe",
		"-frag_duration",
		"500000",
		"-f",
		"mp4",
		"pipe:1"
	];
}
function selectWindowCandidate(windows, bounds, targetTitle = "") {
	const candidates = windows.filter((window) => window.hwnd && window.width > 0 && window.height > 0);
	if (candidates.length === 0) return null;
	const normalizedTitle = targetTitle.trim().toLocaleLowerCase();
	const ranked = candidates.map((window) => {
		return {
			window,
			geometryScore: bounds ? Math.abs((window.x ?? 0) - bounds.left) + Math.abs((window.y ?? 0) - bounds.top) + Math.abs(window.width - bounds.width) + Math.abs(window.height - bounds.height) : 0
		};
	}).sort((a, b) => a.geometryScore - b.geometryScore);
	const closest = ranked.filter((entry) => entry.geometryScore <= ranked[0].geometryScore + 8);
	if (normalizedTitle) {
		const titleMatch = closest.find(({ window }) => String(window.title || "").toLocaleLowerCase().includes(normalizedTitle));
		if (titleMatch) return titleMatch.window;
	}
	return ranked[0].window;
}
async function enumerateWindowsForPid(browserPid, run = execFile$1) {
	if (!Number.isInteger(browserPid) || browserPid <= 0) return [];
	const script = `
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class EgoWindowProbe {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr lParam);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] public static extern bool SetProcessDpiAwarenessContext(IntPtr dpiContext);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc callback, IntPtr lParam);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint processId);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr hwnd);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int maxCount);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hwnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
  public struct RECT { public int Left, Top, Right, Bottom; }
}
'@
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
if (-not [EgoWindowProbe]::SetProcessDpiAwarenessContext([IntPtr](-4))) { [void][EgoWindowProbe]::SetProcessDPIAware() }
$items = [System.Collections.Generic.List[object]]::new()
[void][EgoWindowProbe]::EnumWindows({
  param($hwnd, $lParam)
  $ownerPid = 0
  [void][EgoWindowProbe]::GetWindowThreadProcessId($hwnd, [ref]$ownerPid)
  if ($ownerPid -eq ${browserPid} -and [EgoWindowProbe]::IsWindowVisible($hwnd)) {
    $rect = [EgoWindowProbe+RECT]::new()
    $client = [EgoWindowProbe+RECT]::new()
    $title = [Text.StringBuilder]::new(2048)
    [void][EgoWindowProbe]::GetWindowRect($hwnd, [ref]$rect)
    [void][EgoWindowProbe]::GetClientRect($hwnd, [ref]$client)
    [void][EgoWindowProbe]::GetWindowText($hwnd, $title, $title.Capacity)
    $items.Add([pscustomobject]@{
      hwnd = $hwnd.ToInt64()
      title = $title.ToString()
      x = $rect.Left
      y = $rect.Top
      width = $rect.Right - $rect.Left
      height = $rect.Bottom - $rect.Top
      clientWidth = $client.Right - $client.Left
      clientHeight = $client.Bottom - $client.Top
      minimized = [EgoWindowProbe]::IsIconic($hwnd)
    })
  }
  return $true
}, [IntPtr]::Zero)
ConvertTo-Json -Compress -InputObject @($items)
`;
	const { stdout } = await run("powershell.exe", [
		"-NoProfile",
		"-NonInteractive",
		"-EncodedCommand",
		Buffer.from(script, "utf16le").toString("base64")
	], {
		encoding: "utf8",
		windowsHide: true,
		timeout: 5e3,
		maxBuffer: 1024 * 1024
	});
	const parsed = JSON.parse(stdout.trim() || "[]");
	return Array.isArray(parsed) ? parsed : [parsed];
}
async function resolveCaptureSource({ sessions, targetId, browserPid, platform: platform$1 = process.platform, windowEnumerator = enumerateWindowsForPid }) {
	const value = (await sessions.call(targetId, "Runtime.evaluate", {
		expression: "({screenX,screenY,outerWidth,outerHeight,innerWidth,innerHeight,devicePixelRatio,title:document.title})",
		returnByValue: true
	})).result?.value || {};
	if (![
		value.screenX,
		value.screenY,
		value.outerWidth,
		value.outerHeight,
		value.innerWidth,
		value.innerHeight
	].every((v) => Number.isFinite(v))) {
		const error = /* @__PURE__ */ new Error("Browser window geometry is unavailable");
		error.code = "ffmpeg-capture-source-missing";
		throw error;
	}
	const dpr = Number(value.devicePixelRatio) || 1;
	if (platform$1 === "win32") {
		let bounds = null;
		try {
			const window = await sessions.cdp.call("Browser.getWindowForTarget", { targetId });
			bounds = (await sessions.cdp.call("Browser.getWindowBounds", { windowId: window.windowId })).bounds || window.bounds || null;
		} catch {}
		const selected = selectWindowCandidate(await windowEnumerator(browserPid), bounds, String(value.title || ""));
		if (!selected) {
			const error = /* @__PURE__ */ new Error(`Chrome window not found for browser PID ${browserPid || "unknown"}`);
			error.code = "ffmpeg-window-not-found";
			throw error;
		}
		const targetTitle = String(value.title || "").trim().toLocaleLowerCase();
		const windowTitle = String(selected.title || "").toLocaleLowerCase();
		if (targetTitle && !windowTitle.includes(targetTitle)) {
			const error = /* @__PURE__ */ new Error("The requested target is not the visible tab in its Chrome window");
			error.code = "ffmpeg-target-not-visible";
			throw error;
		}
		if (selected.minimized) {
			const error = /* @__PURE__ */ new Error("The target Chrome window is minimized");
			error.code = "capture-source-not-visible";
			throw error;
		}
		const contentWidth = Math.max(2, Math.round(Number(value.innerWidth) * dpr));
		const contentHeight = Math.max(2, Math.round(Number(value.innerHeight) * dpr));
		const clientWidth = Number(selected.clientWidth) || contentWidth;
		const clientHeight = Number(selected.clientHeight) || contentHeight;
		const cropLeft = Math.max(0, Math.floor((clientWidth - contentWidth) / 2));
		const cropRight = Math.max(0, clientWidth - contentWidth - cropLeft);
		const cropTop = Math.max(0, clientHeight - contentHeight);
		return {
			sourceType: "window-hwnd",
			hwnd: String(selected.hwnd),
			captureX: 0,
			captureY: 0,
			captureWidth: contentWidth,
			captureHeight: contentHeight,
			cropLeft,
			cropTop,
			cropRight,
			cropBottom: 0,
			contentWidthCss: Number(value.innerWidth),
			contentHeightCss: Number(value.innerHeight),
			scaleFactor: dpr,
			minimized: !!selected.minimized
		};
	}
	const chromeX = Math.max(0, (Number(value.outerWidth) - Number(value.innerWidth)) / 2);
	const chromeY = Math.max(0, Number(value.outerHeight) - Number(value.innerHeight) - chromeX);
	return {
		sourceType: "display-crop",
		captureX: Math.round((Number(value.screenX) + chromeX) * dpr),
		captureY: Math.round((Number(value.screenY) + chromeY) * dpr),
		captureWidth: Math.max(2, Math.round(Number(value.innerWidth) * dpr)),
		captureHeight: Math.max(2, Math.round(Number(value.innerHeight) * dpr)),
		contentWidthCss: Number(value.innerWidth),
		contentHeightCss: Number(value.innerHeight),
		scaleFactor: dpr
	};
}

//#endregion
//#region src/worker/capture-ffmpeg.ts
const defaultSpawn = spawn;
function runProbe(path, argv, spawn$1, timeoutMs, captureOutput = false) {
	return new Promise((resolve) => {
		let child;
		let output = "";
		let settled = false;
		const finish = (ok) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			resolve({
				ok,
				output
			});
		};
		try {
			child = spawn$1(path, argv, {
				shell: false,
				windowsHide: true,
				stdio: captureOutput ? [
					"ignore",
					"pipe",
					"pipe"
				] : "ignore"
			});
		} catch {
			resolve({
				ok: false,
				output
			});
			return;
		}
		if (captureOutput) {
			child.stdout?.on("data", (chunk) => {
				output += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				output += chunk.toString();
			});
		}
		const timer = setTimeout(() => {
			try {
				child.kill("SIGTERM");
			} catch {}
			finish(false);
		}, timeoutMs);
		child.once("error", () => finish(false));
		child.once("exit", (code) => finish(code === 0));
	});
}
async function resolveFfmpegPath(configuredPath = "", spawn$1 = defaultSpawn) {
	const candidates = configuredPath ? [configuredPath] : ["ffmpeg"];
	for (const candidate of candidates) try {
		if (candidate !== "ffmpeg") await access(candidate, process.platform === "win32" ? constants.F_OK : constants.X_OK);
		if ((await runProbe(candidate, ["-version"], spawn$1, 3e3)).ok) return candidate;
	} catch {}
	const error = /* @__PURE__ */ new Error(configuredPath ? `FFmpeg is not executable: ${configuredPath}` : "No usable FFmpeg executable was resolved");
	error.code = configuredPath ? "ffmpeg-not-executable" : "ffmpeg-not-installed";
	throw error;
}
async function assertCaptureSupport(path, platform$1 = process.platform, spawn$1 = defaultSpawn) {
	if (platform$1 !== "win32") return;
	const result = await runProbe(path, [
		"-hide_banner",
		"-h",
		"filter=gfxcapture"
	], spawn$1, 3e3, true);
	if (!result.ok || !/Filter gfxcapture\b/.test(result.output)) {
		const error = /* @__PURE__ */ new Error("This FFmpeg build does not support Windows gfxcapture; configure a current FFmpeg build instead of desktop capture");
		error.code = "ffmpeg-gfxcapture-unavailable";
		throw error;
	}
}
async function selectEncoder(path, requested, spawn$1 = defaultSpawn, capture = null, platform$1 = process.platform) {
	if (requested === "software") return "libx264";
	const candidates = requested !== "auto" ? [requested] : platform$1 === "win32" ? [
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"libx264"
	] : process.platform === "darwin" ? ["h264_videotoolbox", "libx264"] : [
		"h264_nvenc",
		"h264_vaapi",
		"h264_qsv",
		"libx264"
	];
	for (const encoder of candidates) {
		const encoderArgs = encoder === "h264_mf" ? [
			"-c:v",
			encoder,
			"-hw_encoding",
			"1",
			"-scenario",
			"display_remoting"
		] : ["-c:v", encoder];
		if ((await runProbe(path, [
			"-hide_banner",
			"-loglevel",
			"error",
			...platform$1 === "win32" && capture?.source ? buildCaptureInput({
				source: capture.source,
				fps: capture.fps,
				maxWidth: capture.maxWidth,
				encoder
			}) : [
				"-f",
				"lavfi",
				"-i",
				"color=size=64x64:rate=1"
			],
			"-frames:v",
			"1",
			...encoderArgs,
			"-f",
			"null",
			"-"
		], spawn$1, 2e3)).ok) return encoder;
	}
	const error = /* @__PURE__ */ new Error(`FFmpeg encoder is unavailable: ${requested}`);
	error.code = "ffmpeg-encoder-unavailable";
	throw error;
}
function codecFromAvcInit(buffer) {
	const index = Buffer.from(buffer).indexOf(Buffer.from("avcC"));
	if (index < 0 || index + 8 > buffer.length) return "avc1.42E01E";
	return `avc1.${[
		buffer[index + 5],
		buffer[index + 6],
		buffer[index + 7]
	].map((value) => value.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}
var FfmpegCaptureBackend = class {
	sessions;
	browserPid;
	getConfig;
	generation;
	onStatus;
	onVideoInit;
	onVideoChunk;
	onVideoEnd;
	spawn;
	sourceResolver;
	pathResolver;
	supportProbe;
	child;
	stopping;
	termination;
	offDestroyed;
	stderr;
	targetId;
	constructor({ sessions, browserPid, getConfig, generation, onStatus, onVideoInit, onVideoChunk, onVideoEnd, spawn: spawn$1 = defaultSpawn, sourceResolver = resolveCaptureSource, pathResolver = resolveFfmpegPath, supportProbe = assertCaptureSupport }) {
		this.sessions = sessions;
		this.browserPid = browserPid;
		this.getConfig = getConfig;
		this.generation = generation;
		this.onStatus = onStatus;
		this.onVideoInit = onVideoInit;
		this.onVideoChunk = onVideoChunk;
		this.onVideoEnd = onVideoEnd;
		this.spawn = spawn$1;
		this.sourceResolver = sourceResolver;
		this.pathResolver = pathResolver;
		this.supportProbe = supportProbe;
		this.child = null;
		this.stopping = null;
		this.termination = null;
		this.targetId = "";
		this.offDestroyed = sessions.onDestroyed?.((targetId) => {
			if (this.targetId !== targetId) return;
			this.onStatus({
				backend: "ffmpeg",
				state: "failed",
				targetId,
				code: "capture-target-destroyed",
				message: "The watched target was closed"
			});
			this.stop("target-destroyed").catch(() => {});
		}) ?? null;
		this.stderr = Buffer.alloc(0);
	}
	async start({ targetId }) {
		this.targetId = targetId;
		const config = this.getConfig();
		this.onStatus({
			backend: "ffmpeg",
			state: "starting",
			targetId,
			message: "Resolving FFmpeg binary"
		});
		const [path, source] = await Promise.all([this.pathResolver(config.ffmpegResolvedPath || config.ffmpegPath), this.sourceResolver({
			sessions: this.sessions,
			targetId,
			browserPid: this.browserPid
		})]);
		await this.supportProbe(path);
		this.onStatus({
			backend: "ffmpeg",
			state: "starting",
			targetId,
			message: "Probing H.264 encoder"
		});
		const encoder = await selectEncoder(path, config.ffmpegEncoder, this.spawn, {
			source,
			fps: config.ffmpegFps,
			maxWidth: config.ffmpegMaxWidth
		});
		this.onStatus({
			backend: "ffmpeg",
			state: "starting",
			targetId,
			message: `Starting capture with ${encoder}`
		});
		const argv = [
			"-hide_banner",
			"-loglevel",
			"warning",
			...buildCaptureInput({
				source,
				fps: config.ffmpegFps,
				maxWidth: config.ffmpegMaxWidth,
				encoder
			}),
			...buildEncoderArgs({
				encoder,
				fps: config.ffmpegFps,
				maxWidth: config.ffmpegMaxWidth,
				bitrateKbps: config.ffmpegBitrateKbps,
				source
			})
		];
		const child = this.spawn(path, argv, {
			shell: false,
			windowsHide: true,
			stdio: [
				"pipe",
				"pipe",
				"pipe"
			]
		});
		this.child = child;
		let initialized = false;
		const parser = new Mp4FragmentParser({
			onInit: (buffer) => {
				if (this.child !== child) return;
				initialized = true;
				const mime = `video/mp4; codecs="${codecFromAvcInit(buffer)}"`;
				this.onVideoInit({
					targetId,
					mime,
					width: source.contentWidthCss,
					height: source.contentHeightCss,
					generation: this.generation,
					buffer
				});
				this.onStatus({
					backend: "ffmpeg",
					state: "streaming",
					targetId,
					encoder,
					mime,
					code: null,
					message: null
				});
			},
			onFragment: (buffer) => {
				if (this.child === child) this.onVideoChunk({
					generation: this.generation,
					buffer
				});
			}
		});
		child.stdout.on("data", (chunk) => {
			try {
				parser.push(chunk);
			} catch (error) {
				this.#fail(child, targetId, "video-stream-corrupt", error);
			}
		});
		child.stdout.once("end", () => {
			try {
				parser.end();
			} catch (error) {
				if (this.child === child) this.#fail(child, targetId, "video-stream-corrupt", error);
			}
		});
		child.stderr.on("data", (chunk) => {
			this.stderr = Buffer.concat([this.stderr, Buffer.from(chunk)]).subarray(-65536);
		});
		child.once("error", (error) => this.#fail(child, targetId, "ffmpeg-not-executable", error));
		child.once("exit", (code, signal) => {
			if (this.child !== child) return;
			this.child = null;
			this.onVideoEnd({ generation: this.generation });
			this.onStatus({
				backend: "ffmpeg",
				state: "failed",
				targetId,
				code: "ffmpeg-capture-failed",
				message: this.stderr.toString("utf8") || `FFmpeg exited unexpectedly (${code ?? signal})`
			});
		});
		await new Promise((resolve, reject) => {
			const finish = (callback, value) => {
				clearTimeout(timer);
				clearInterval(check);
				callback(value);
			};
			const timer = setTimeout(() => finish(reject, /* @__PURE__ */ new Error("FFmpeg did not produce an MP4 init segment within 8 seconds")), 8e3);
			const check = setInterval(() => {
				if (initialized) finish(resolve, void 0);
				else if (this.child !== child) finish(reject, /* @__PURE__ */ new Error("FFmpeg exited before the MP4 init segment"));
			}, 20);
		}).catch(async (error) => {
			await this.stop("startup-failed");
			throw error;
		});
	}
	async switchTarget({ targetId }) {
		await this.stop("target-switch");
		await this.start({ targetId });
	}
	async updateConfig() {}
	async stop(reason = "stopped") {
		if (this.termination) return this.termination;
		const child = this.child;
		this.child = null;
		if (!child) return;
		this.termination = (async () => {
			this.stopping = child;
			try {
				child.stdin?.write("q\n");
			} catch {}
			await Promise.race([new Promise((resolve) => child.once("exit", () => resolve())), new Promise((resolve) => setTimeout(() => resolve(), 1500))]);
			if (child.exitCode === null) {
				try {
					child.kill("SIGTERM");
				} catch {}
				await Promise.race([new Promise((resolve) => child.once("exit", () => resolve())), new Promise((resolve) => setTimeout(() => resolve(), 1e3))]);
			}
			if (child.exitCode === null) {
				try {
					child.kill("SIGKILL");
				} catch {}
				await new Promise((resolve) => child.once("exit", () => resolve()));
			}
			this.stopping = null;
			this.onVideoEnd({
				generation: this.generation,
				reason
			});
		})();
		try {
			await this.termination;
		} finally {
			this.termination = null;
		}
	}
	status() {
		return {
			backend: "ffmpeg",
			state: this.child ? "streaming" : "idle",
			generation: this.generation
		};
	}
	#fail(child, targetId, code, error) {
		if (this.child !== child) return;
		this.onStatus({
			backend: "ffmpeg",
			state: "failed",
			targetId,
			code,
			message: error.message
		});
		this.stop(code).catch(() => {});
	}
	dispose() {
		this.offDestroyed?.();
		this.offDestroyed = null;
	}
};

//#endregion
//#region src/worker/ego-cast-worker.ts
const SENTINEL = "@@DSH_RESULT@@";
const HOME = homedir() || process.env.HOME || process.env.USERPROFILE || "/root";
const IS_WIN = platform() === "win32";
const STATE_HOME = IS_WIN ? process.env.LOCALAPPDATA || join(HOME, "AppData", "Local") : process.env.XDG_STATE_HOME || join(HOME, ".local", "state");
const STATE_DIR = process.env.EGO_LINUX_STATE_DIR || join(STATE_HOME, "ego-lite-linux");
const BROWSER_STATE_FILE = join(STATE_DIR, "browser.json");
const CAST_STATE_FILE = join(STATE_DIR, "ego-cast.json");
let castConfig = {
	captureBackend: "auto",
	streamProfile: "balanced",
	ffmpegFallbackReason: "",
	cdpFps: 20,
	cdpQuality: 55,
	cdpMaxWidth: 960,
	cdpBackstopIntervalMs: 3e3,
	ffmpegFps: 20,
	ffmpegMaxWidth: 1280,
	ffmpegBitrateKbps: 4e3,
	ffmpegEncoder: "auto",
	ffmpegPath: "",
	ffmpegResolvedPath: ""
};
try {
	castConfig = {
		...castConfig,
		...JSON.parse(process.argv[2] || "{}")
	};
} catch {}
const HUMAN_PROBE_JS = `(() => {
  const el=document.querySelector('iframe[src*="recaptcha"],.g-recaptcha,.h-captcha,iframe[src*="hcaptcha"],.cf-turnstile,iframe[src*="turnstile"],iframe[src*="cloudflare"],#challenge-form,.challenge-form,#captcha,.captcha');
  if(el)return{detected:true,kind:/recaptcha/i.test(el.outerHTML)?'recaptcha':/hcaptcha/i.test(el.outerHTML)?'hcaptcha':/turnstile/i.test(el.outerHTML)?'turnstile':'captcha'};
  const t=((document.body&&document.body.innerText)||'').slice(0,120000).toLowerCase();
  return /verify you are human|your activity looks unusual|captcha|i.?m not a robot|人机验证|安全验证|我是人类|验证码|滑块验证/.test(t)?{detected:true,kind:'captcha'}:{detected:false,kind:null};
})()`;
const sseClients = /* @__PURE__ */ new Set();
const videoClients = /* @__PURE__ */ new Set();
const probeCache = /* @__PURE__ */ new Map();
const frameCache = /* @__PURE__ */ new Map();
let active = null;
let currentStatus = {
	backend: "cdp",
	state: "idle",
	targetId: null,
	generation: 0,
	watchers: 0
};
let videoInit = null;
function normalizeConfig(input) {
	const next = { ...castConfig };
	const enumValue = (key, values) => {
		if (values.includes(input[key])) next[key] = input[key];
	};
	const numberValue = (key, min, max) => {
		const v = input[key];
		if (Number.isFinite(v) && v >= min && v <= max) next[key] = v;
	};
	enumValue("captureBackend", [
		"auto",
		"cdp",
		"ffmpeg"
	]);
	if (typeof input.ffmpegFallbackReason === "string") next.ffmpegFallbackReason = input.ffmpegFallbackReason;
	enumValue("streamProfile", [
		"low",
		"balanced",
		"high"
	]);
	enumValue("ffmpegEncoder", [
		"auto",
		"software",
		"h264_mf",
		"h264_nvenc",
		"h264_qsv",
		"h264_amf",
		"h264_videotoolbox",
		"h264_vaapi"
	]);
	numberValue("cdpFps", 5, 30);
	numberValue("cdpQuality", 1, 100);
	numberValue("cdpMaxWidth", 320, 1920);
	numberValue("cdpBackstopIntervalMs", 1e3, 1e4);
	numberValue("ffmpegFps", 5, 30);
	numberValue("ffmpegMaxWidth", 320, 1920);
	numberValue("ffmpegBitrateKbps", 500, 2e4);
	if (typeof input.ffmpegPath === "string") next.ffmpegPath = input.ffmpegPath;
	if (typeof input.ffmpegResolvedPath === "string") next.ffmpegResolvedPath = input.ffmpegResolvedPath;
	return next;
}
castConfig = normalizeConfig(castConfig);
function sendJson(res, status, body) {
	const payload = JSON.stringify(body);
	res.writeHead(status, {
		"content-type": "application/json",
		"content-length": Buffer.byteLength(payload),
		"cache-control": "no-store"
	});
	res.end(payload);
}
async function readJson(req, maxBytes = 8192) {
	const chunks = [];
	let size = 0;
	for await (const chunk of req) {
		size += chunk.length;
		if (size > maxBytes) throw new Error("body too large");
		chunks.push(Buffer.from(chunk));
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}
function writeSse(res, event, payload) {
	return res.write(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);
}
function queueSse(client, event, payload) {
	if (event === "frame") client.pendingFrame = payload;
	else client.pendingEvents.set(event, payload);
}
function sendSse(client, event, payload) {
	if (client.blocked) {
		queueSse(client, event, payload);
		return;
	}
	try {
		if (!writeSse(client.res, event, payload)) {
			client.blocked = true;
			client.res.once("drain", () => {
				client.blocked = false;
				const pendingEvents = [...client.pendingEvents];
				const pendingFrame = client.pendingFrame;
				client.pendingEvents.clear();
				client.pendingFrame = null;
				for (const [pendingEvent, pendingPayload] of pendingEvents) sendSse(client, pendingEvent, pendingPayload);
				if (pendingFrame) sendSse(client, "frame", pendingFrame);
			});
		}
	} catch {
		sseClients.delete(client);
	}
}
function broadcast(event, payload) {
	for (const client of sseClients) sendSse(client, event, payload);
}
function publishStatus(status) {
	currentStatus = {
		...currentStatus,
		...status
	};
	broadcast("capture-status", currentStatus);
}
function publishJpeg(frame) {
	frameCache.delete(frame.targetId);
	frameCache.set(frame.targetId, {
		frame: frame.data,
		lastActive: frame.ts,
		viewportW: frame.vw,
		viewportH: frame.vh
	});
	while (frameCache.size > 30) frameCache.delete(frameCache.keys().next().value);
	broadcast("frame", frame);
}
function publishVideoInit(event) {
	videoInit = {
		generation: event.generation,
		mime: "",
		buffer: event.buffer
	};
	for (const client of videoClients) if (client.generation === event.generation) writeVideo(client, event.buffer);
}
function publishVideoChunk(event) {
	for (const client of videoClients) if (client.generation === event.generation) writeVideo(client, event.buffer);
}
function writeVideo(client, buffer) {
	if (client.blocked) {
		client.queue.push(buffer);
		if (client.queue.length > 8) {
			videoClients.delete(client);
			try {
				client.res.destroy(/* @__PURE__ */ new Error("video client is too slow"));
			} catch {}
		}
		return;
	}
	try {
		if (!client.res.write(buffer)) {
			client.blocked = true;
			client.res.once("drain", () => {
				client.blocked = false;
				const pending = client.queue.shift();
				if (pending) writeVideo(client, pending);
			});
		} else if (client.queue.length > 0) writeVideo(client, client.queue.shift());
	} catch {
		videoClients.delete(client);
	}
}
function endVideo({ generation } = {}) {
	for (const client of [...videoClients]) if (generation === void 0 || client.generation === generation) {
		videoClients.delete(client);
		try {
			client.res.end();
		} catch {}
	}
}
const manager = new CaptureManager({
	getConfig: () => castConfig,
	onStatus: publishStatus,
	backendFactories: {
		cdp: ({ onStatus }) => {
			if (!active) throw new Error("no live browser");
			return new CdpCaptureBackend({
				cdp: active.cdp,
				sessions: active.sessions,
				getConfig: () => castConfig,
				onStatus,
				onJpegFrame: publishJpeg
			});
		},
		ffmpeg: ({ generation, onStatus }) => {
			if (!active) throw new Error("no live browser");
			return new FfmpegCaptureBackend({
				sessions: active.sessions,
				browserPid: active.pid ?? 0,
				getConfig: () => castConfig,
				generation,
				onStatus,
				onVideoInit: publishVideoInit,
				onVideoChunk: publishVideoChunk,
				onVideoEnd: endVideo
			});
		}
	}
});
async function readBrowserState() {
	try {
		return JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(BROWSER_STATE_FILE, "utf8")));
	} catch {
		return null;
	}
}
async function resolveBrowser() {
	if (process.env.EGO_LINUX_CDP_URL) return {
		wsUrl: process.env.EGO_LINUX_CDP_URL,
		port: null
	};
	const state = await readBrowserState();
	if (!state?.port) return null;
	try {
		const response = await fetch(`http://127.0.0.1:${state.port}/json/version`, { signal: AbortSignal.timeout(1500) });
		const wsUrl = response.ok ? (await response.json()).webSocketDebuggerUrl : null;
		return wsUrl ? {
			port: state.port ?? null,
			wsUrl
		} : null;
	} catch {
		return null;
	}
}
async function listTargets() {
	if (!active) return [];
	return ((await active.cdp.call("Target.getTargets")).targetInfos || []).filter((target) => target.type === "page");
}
async function activeTargetId() {
	if (!active?.port) return currentStatus.targetId || null;
	try {
		const response = await fetch(`http://127.0.0.1:${active.port}/json/list`, { signal: AbortSignal.timeout(1500) });
		return (response.ok ? await response.json() : []).find((entry) => entry.type === "page")?.id || currentStatus.targetId || null;
	} catch {
		return currentStatus.targetId || null;
	}
}
async function snapshotSpaces() {
	const targets = await listTargets();
	const activeId = await activeTargetId();
	const spaces = [];
	for (const target of targets.slice(0, 30)) {
		const frame = frameCache.get(target.targetId);
		const session = active.sessions.get(target.targetId);
		const cached = probeCache.get(target.targetId);
		if (!cached || Date.now() - cached.at > 5e3) active.sessions.call(target.targetId, "Runtime.evaluate", {
			expression: HUMAN_PROBE_JS,
			returnByValue: true,
			awaitPromise: false
		}, 3e3).then((result) => {
			const r = result;
			probeCache.set(target.targetId, {
				at: Date.now(),
				human: r.result?.value || null
			});
		}).catch(() => {});
		spaces.push({
			targetId: target.targetId,
			url: target.url,
			title: target.title,
			active: target.targetId === activeId,
			lastActive: frame?.lastActive || 0,
			viewportW: frame?.viewportW || session?.viewportW,
			viewportH: frame?.viewportH || session?.viewportH,
			humanCheck: cached?.human || null
		});
	}
	spaces.sort((a, b) => Number(b.active) - Number(a.active) || b.lastActive - a.lastActive);
	return spaces;
}
async function connectLoop() {
	while (true) {
		const browser = await resolveBrowser();
		if (!browser) {
			await sleep(3e3);
			continue;
		}
		try {
			const ws = new import_websocket.default(browser.wsUrl);
			await new Promise((resolve, reject) => {
				ws.addEventListener("open", () => resolve(), { once: true });
				ws.addEventListener("error", () => reject(/* @__PURE__ */ new Error("ws error")), { once: true });
			});
			const cdp = new CdpClient(ws);
			const sessions = new TargetSessions(cdp);
			active = {
				...browser,
				ws,
				cdp,
				sessions
			};
			publishStatus({ browserConnected: true });
			await manager.browserConnected();
			await new Promise((resolve) => {
				ws.addEventListener("close", () => resolve(), { once: true });
				ws.addEventListener("error", () => resolve(), { once: true });
			});
			await manager.browserDisconnected();
			await sessions.dispose();
		} catch (error) {
			publishStatus({
				state: "failed",
				code: "browser-disconnected",
				message: error.message,
				browserConnected: false
			});
		} finally {
			active = null;
			await sleep(2e3);
		}
	}
}
function sleep(ms) {
	return new Promise((resolve) => setTimeout(resolve, ms));
}
function stopSiblingWorkers() {
	const self = String(process.pid);
	if (IS_WIN) {
		const ps = `Get-CimInstance Win32_Process -Filter "Name='node.exe'" | Where-Object { $_.CommandLine -like '*ego-cast-worker.mjs*' -and $_.ProcessId -ne ${self} } | Select-Object -ExpandProperty ProcessId`;
		try {
			const output = execFileSync("powershell.exe", [
				"-NoProfile",
				"-NonInteractive",
				"-EncodedCommand",
				Buffer.from(ps, "utf16le").toString("base64")
			], {
				encoding: "utf8",
				timeout: 8e3
			});
			for (const line of output.split(/\r?\n/)) if (/^\d+$/.test(line.trim())) try {
				execFileSync("taskkill", [
					"/PID",
					line.trim(),
					"/T",
					"/F"
				], { stdio: "ignore" });
			} catch {}
		} catch {}
		return;
	}
	try {
		const output = execFileSync("ps", ["-eo", "pid=,args="], {
			encoding: "utf8",
			timeout: 8e3
		});
		for (const line of output.split("\n")) {
			const match = line.match(/^\s*(\d+)\s+(.+)$/);
			if (match && match[1] !== self && match[2].includes("ego-cast-worker.mjs")) try {
				process.kill(Number(match[1]), "SIGTERM");
			} catch {}
		}
	} catch {}
}
async function main() {
	stopSiblingWorkers();
	rmSync(CAST_STATE_FILE, { force: true });
	const server = createServer(async (req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1");
		try {
			if (req.method === "GET" && url.pathname === "/api/health") return sendJson(res, 200, {
				workerOk: true,
				browserConnected: !!active,
				capture: manager.status()
			});
			if (req.method === "GET" && url.pathname === "/api/spaces") return sendJson(res, 200, {
				ok: true,
				spaces: active ? await snapshotSpaces() : [],
				capture: manager.status()
			});
			if (req.method === "GET" && url.pathname === "/api/watch/status") return sendJson(res, 200, {
				ok: true,
				...manager.status()
			});
			if (req.method === "GET" && url.pathname === "/api/video/status") return sendJson(res, 200, {
				ok: true,
				...manager.status(),
				mime: videoInit?.mime || null
			});
			if (req.method === "POST" && url.pathname === "/api/config") {
				castConfig = normalizeConfig(await readJson(req));
				await manager.updateConfig();
				return sendJson(res, 200, {
					ok: true,
					config: castConfig
				});
			}
			if (req.method === "POST" && url.pathname === "/api/watch/start") {
				if (!active) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				return sendJson(res, 200, {
					ok: true,
					...await manager.startWatch(await readJson(req))
				});
			}
			if (req.method === "POST" && url.pathname === "/api/watch/switch") return sendJson(res, 200, {
				ok: true,
				...await manager.switchWatch(await readJson(req))
			});
			if (req.method === "POST" && url.pathname === "/api/watch/stop") return sendJson(res, 200, {
				ok: true,
				...await manager.stopWatch(await readJson(req))
			});
			if (req.method === "POST" && url.pathname === "/api/input") {
				const body = await readJson(req);
				if (!active) return sendJson(res, 409, {
					ok: false,
					code: "browser-disconnected",
					error: "no live browser"
				});
				if (!body.targetId) return sendJson(res, 400, {
					ok: false,
					code: "target-required",
					error: "targetId required"
				});
				if (!(await listTargets()).some((target) => target.targetId === body.targetId)) return sendJson(res, 409, {
					ok: false,
					code: "capture-target-stale",
					error: "target is no longer available"
				});
				try {
					return sendJson(res, 200, await active.sessions.sendInput(body.targetId, body));
				} catch (error) {
					return sendJson(res, 503, {
						ok: false,
						code: "input-dispatch-failed",
						error: error.message || String(error)
					});
				}
			}
			if (req.method === "POST" && url.pathname === "/api/close") {
				const { targetId } = await readJson(req);
				if (!active || !targetId) return sendJson(res, 400, {
					ok: false,
					error: "targetId required"
				});
				await active.cdp.call("Target.closeTarget", { targetId });
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "POST" && url.pathname === "/api/flush") {
				if (!active) return sendJson(res, 409, {
					ok: false,
					error: "no live browser"
				});
				await active.cdp.call("Storage.flushCookies").catch(() => {});
				return sendJson(res, 200, { ok: true });
			}
			if (req.method === "GET" && url.pathname === "/api/stream") {
				res.writeHead(200, {
					"content-type": "text/event-stream",
					"cache-control": "no-cache",
					connection: "keep-alive",
					"x-accel-buffering": "no"
				});
				res.write(":ok\n\n");
				const client = {
					res,
					blocked: false,
					pendingFrame: null,
					pendingEvents: /* @__PURE__ */ new Map()
				};
				sseClients.add(client);
				writeSse(res, "capture-status", manager.status());
				snapshotSpaces().then((spaces) => {
					if (sseClients.has(client)) writeSse(res, "spaces", spaces);
				}).catch(() => {});
				const close = () => {
					sseClients.delete(client);
				};
				req.on("close", close);
				res.on("close", close);
				return;
			}
			if (req.method === "GET" && url.pathname === "/api/video/stream") {
				const generation = Number(url.searchParams.get("generation"));
				if (!videoInit || generation !== currentStatus.generation || generation !== videoInit.generation) return sendJson(res, 409, {
					ok: false,
					error: "stale video generation",
					generation: currentStatus.generation
				});
				res.writeHead(200, {
					"content-type": "video/mp4",
					"cache-control": "no-store",
					"x-ego-generation": String(generation),
					"x-ego-backend": "ffmpeg"
				});
				const client = {
					res,
					generation,
					blocked: false,
					queue: []
				};
				videoClients.add(client);
				writeVideo(client, videoInit.buffer);
				const close = () => {
					videoClients.delete(client);
				};
				req.on("close", close);
				res.on("close", close);
				return;
			}
			sendJson(res, 404, {
				ok: false,
				error: "not found"
			});
		} catch (error) {
			sendJson(res, 500, {
				ok: false,
				error: error.message || String(error)
			});
		}
	});
	await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
	const port = server.address().port;
	mkdirSync(STATE_DIR, { recursive: true });
	writeFileSync(CAST_STATE_FILE, JSON.stringify({
		port,
		pid: process.pid
	}, null, 2));
	const metadataTimer = setInterval(() => {
		if (!active || sseClients.size === 0) return;
		snapshotSpaces().then((spaces) => broadcast("spaces", spaces)).catch(() => {});
	}, 1e3);
	const shutdown = async () => {
		clearInterval(metadataTimer);
		await manager.dispose().catch(() => {});
		try {
			active?.ws?.close();
		} catch {}
		try {
			if (JSON.parse(await import("node:fs/promises").then((fs) => fs.readFile(CAST_STATE_FILE, "utf8"))).pid === process.pid) rmSync(CAST_STATE_FILE, { force: true });
		} catch {}
		server.close();
		process.exit(0);
	};
	process.on("SIGTERM", shutdown);
	process.on("SIGINT", shutdown);
	console.log(`${SENTINEL}${JSON.stringify({
		ok: true,
		port,
		pid: process.pid
	})}`);
	connectLoop().catch((error) => console.error("ego-cast-worker: connect loop failed", error));
}
main().catch((error) => {
	console.error("ego-cast-worker failed:", error.stack || error.message);
	process.exit(1);
});

//#endregion
export {  };
//# sourceMappingURL=ego-cast-worker.mjs.map