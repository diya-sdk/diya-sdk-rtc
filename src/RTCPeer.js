const EventEmitter = require('node-event-emitter')
const messageify = require('./messageify-browser.js')
const debug = require('debug')('rtc:peer');

class RTCPeer extends EventEmitter {
	constructor (id, channels, dbusObject) {
		super ()
		this.id = id
		this.channels = channels
		this._dbusObject = dbusObject

		//default turn servers
		this._turnServers = [ {urls: [ "stun:stun.l.google.com:19302" ]} ];

		this._connect ()
	}

	close () {
		console.log("Peer "+this.id+" closed !")
		this.channels.forEach (c => c.close())
		this.channels = []


		try {
			this._sendSignalingMessage ({
				func: 'Close'
			})
		} catch (err) {
			console.warn("RTC: 'close' signaling failed")
			debug(err)
		}


		if (this._peerConnection == null) {
			return
		}
		this._peerConnection.close()

		setTimeout(() => {
			this._disconnectSignaling ()

			// just in case garbage collector needs some help
			this._peerConnection = null
		})
	}

	_connect () {
		console.log("trying to connect to peer "+this.id+"...")

		this._connectSignaling ()
	}

	////////////////////////////////////////////////////////
	//////////////// Signaling methods /////////////////////
	////////////////////////////////////////////////////////

	_connectSignaling () {
		this._dbusObject.call('fr.partnering.RTC.Connect', {
			localPeerId: this.id,
			channels: this.channels.map (c => c.name)
		}, (_, err, sessionToken) => {
			console.log("session token for peer "+this.id+" : "+sessionToken)
			this._dbusObject._d1inst(this._dbusObject._peerId)
				.openSocket('/var/run/diya/rtc.sock', (_, err, socket) => {
					if (err != null) {
						console.error(err)
					}
					if (socket != null) {
						socket.write(`${sessionToken}\n`)
						this._onSignalingConnected(messageify(socket))
					} else {
						console.warn("No socket! Could not connect!")
					}
				})
		})
	}

	_disconnectSignaling () {
		console.log(`disconnecting signaling for peer ${this.id}`)
		this._signaling.disconnect()
	}

	_onSignalingConnected (socket) {
		console.log('signaling connected for peer '+this.id)
		this._signaling = socket

		this._signaling.on('message', data => {
			this._onSignalingMessage(JSON.parse(data))
		})
	}

	_sendSignalingMessage (message) {
		let data = JSON.stringify (message)
		if (this._signaling != null) {
			this._signaling.sendMessage (data)
		} else {
			console.error("No _signaling")
		}
	}

	_onSignalingMessage (message) {
		switch (message.func) {
			case "TurnInfo":
				this._onTurnInfo (message)
				break
			case "RemoteOffer":
				this._onRemoteOffer (message)
				break
			case "RemoteICECandidate":
				this._onRemoteICECandidate (message)
				break
			default:
				break
		}
	}

	///////////////////////////////////////////////////////////////
	/////////////// Remote peer messages handling     /////////////
	///////////////////////////////////////////////////////////////

	_onTurnInfo (turnInfos) {
		if (!Array.isArray(turnInfos.servers)) return

		this._turnServers = turnInfos.servers.map(server => {
			return {
				urls: [ server.url ],
				username: server.username,
				credential: server.password
			}
		})
	}

	_onRemoteOffer (offer) {
		this._peerConnection = new RTCPeerConnection({
			iceServers: this._turnServers,
			iceTransportPolicy: 'all'
		}, {
			mandatory: {
				DtlsSrtpKeyAgreement: true,
				OfferToReceiveAudio: true,
				OfferToReceiveVideo:true
			}
		})

		this._peerConnection.setRemoteDescription(new RTCSessionDescription({
			sdp: offer.sdp,
			type: offer.type
		}))

		this._peerConnection.createAnswer(
			localSDP => this._onLocalSDP(localSDP),
			err => console.error (err),
			{ mandatory: { 	OfferToReceiveAudio: true, OfferToReceiveVideo: true }}
		)

		this._peerConnection.oniceconnectionstatechange = () => this._onICEConnectionStateChange ()
		this._peerConnection.onicecandidate = candidate => this._onLocalICECandidate (candidate)
		this._peerConnection.ondatachannel = channel => this._onDataChannel (channel)
		this._peerConnection.onaddstream = stream => this._onAddStream (stream)
	}

	_onRemoteICECandidate (evt) {
		let candidate = new RTCIceCandidate(evt.candidate)
		this._peerConnection.addIceCandidate(candidate, () => {}, err => console.log(err));
	}

	//////////////////////////////////////////////
	////// local peer connection events //////////
	//////////////////////////////////////////////


	_onLocalSDP (localSDP) {
		if (this._peerConnection == null) {
			return
		}
		this._peerConnection.setLocalDescription(localSDP);

		this._sendSignalingMessage({
			func: "Answer",
			type: localSDP.type,
			sdp: localSDP.sdp
		})
	}

	_onLocalICECandidate (evt) {
		this._sendSignalingMessage ({
			func: 'ICECandidate',
			candidate: evt.candidate
		})
	}

	_onICEConnectionStateChange () {
		if (this._peerConnection == null) {
			console.warn("ICE connection state : no peerConnection!")
		} else {
			console.log("ICE connection state : "
			            + this._peerConnection.iceConnectionState)
		}
	}

	_onDataChannel (evt) {
		let channel = this.channels.find(c => c.name === evt.channel.label)
		if (channel == null) {
			console.warn (`no matching channel found for ${evt.channel.label}. Closing...`)
			evt.channel.close()
			return
		}

		channel.setDataChannel (evt.channel)
	}

	_onAddStream (evt) {
		let channel = this.channels.find(c => c.name === evt.stream.id)
		if (channel == null) {
			console.warn (`no matching channel found for ${evt.channel.label}. Closing...`)
			evt.stream.close()
			return
		}

		channel.setStream (evt.stream)
	}
}


module.exports = RTCPeer
