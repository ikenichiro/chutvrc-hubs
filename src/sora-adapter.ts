import Sora, * as SoraType from "sora-js-sdk";
import { debug as newDebug } from "debug";
import { SFU_CONNECTION_CONNECTED, SFU_CONNECTION_ERROR_FATAL, SfuAdapter } from "./sfu-adapter";
import { MediaDevices } from "./utils/media-devices-utils";

const debug = newDebug("naf-dialog-adapter:debug");
const sendStats: any[] = [];
const recvStats: any[] = [];

type ConnectProps = {
  clientId: string;
  channelId: string;
  signalingUrl: string;
  accessToken: string;
  debug: boolean;
  options?: SoraType.ConnectionOptions;
}

export class SoraAdapter extends SfuAdapter {
  _clientId: string;
  _sendrecv: SoraType.ConnectionPublisher | null;
  _localMediaStream: MediaStream | null;
  _remoteMediaStreams: Map<string, MediaStream | null>;
  _clientStreamIdPair: Map<string, string>;
  _pendingMediaRequests: Map<string, any>;
  _blockedClients: Map<string, boolean>;
  _micShouldBeEnabled: boolean;
  _scene: Element | null;
  _recordStatsId: NodeJS.Timer;

  constructor() {
    super();
    this._clientId = "";
    this._sendrecv = null;
    this._localMediaStream = null;
    this._remoteMediaStreams = new Map<string, MediaStream | null>();
    this._clientStreamIdPair = new Map<string, string>();
    this._pendingMediaRequests = new Map<string, any>();
    this._blockedClients = new Map<string, boolean>();
    this._micShouldBeEnabled = false;
  }

  async connect({ clientId, channelId, signalingUrl, accessToken, debug }: ConnectProps) {
    const sora = Sora.connection(signalingUrl, debug);
    const metadata = { access_Token: accessToken };
    const options = {
      clientId: clientId,
      audio: true,
      multistream: true,
      video: true,
    };

    this._clientId = clientId;
    this._sendrecv = sora.sendrecv(channelId, metadata, options);
    this._sendrecv.on("notify", event => {
      if (event.event_type === "connection.created") {
        // console.log("connection.created");
        // console.log("my cid: " + this._clientId);
        event.data?.forEach(c => {
          // console.log(c.connection_id);
          // clients entering this room earlier
          if (c.client_id && c.connection_id && !this._clientStreamIdPair.has(c.client_id)) {
            this._clientStreamIdPair.set(c.client_id, c.connection_id);
            console.log("old client _clientStreamIdPair.set");
            console.log(c.client_id);
            console.log(c.connection_id);
            this.resolvePendingMediaRequestForTrack(c.client_id);
          }
        });
        // clients entering this room later
        if (event.client_id && event.connection_id && !this._clientStreamIdPair.has(event.client_id)) {
          this._clientStreamIdPair.set(event.client_id, event.connection_id);
          // console.log("new client _clientStreamIdPair.set");
          // console.log(event.client_id);
          // console.log(event.connection_id);
          this.emit("stream_updated", event.client_id, "audio");
          this.emit("stream_updated", event.client_id, "video");
        }
      }
      if (event.event_type === "connection.updated") {
        this.emit("stream_updated", event.client_id, "audio");
        this.emit("stream_updated", event.client_id, "video");
      }
    })
    this._sendrecv.on("track", event => {
      // console.log("track");
      const stream = event.streams[0];
      if (!stream) return;
      // console.log(stream.id);
      if (!this._remoteMediaStreams.has(stream.id)) {
        // console.log("_remoteMediaStreams.set");
        this._remoteMediaStreams.set(stream.id, stream);
      }
    });
    this._sendrecv.on("removetrack", event => {
      // @ts-ignore
      console.log("Track removed: " + event.track.id);
    });
    this._localMediaStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
    this._sendrecv
      .connect(this._localMediaStream)
      .then(stream => {
        if (this._sendrecv) {
          this.emit(this._sendrecv.stream ? SFU_CONNECTION_CONNECTED : SFU_CONNECTION_ERROR_FATAL);
        }
      })
      .catch(e => {
        console.error(e);
        this.emit(SFU_CONNECTION_ERROR_FATAL);
        this.enableMicrophone(false);
      })
      .finally(() => this.enableMicrophone(false));
  }

  async disconnect() {
    if (this._sendrecv) {
      await this._sendrecv.disconnect();
      this._sendrecv = null;
    }
    debug("disconnect()");
    // ...
    this.emitRTCEvent("info", "Signaling", () => `[close]`);
  }

  getMediaStream(clientId: string, kind = "audio") {
    let stream: MediaStream | null | undefined = null;
    let streamId: string | null | undefined = null;
    let tracks: MediaStreamTrack[] | null | undefined = null;

    if (this._clientId === clientId) {
      stream = this._sendrecv?.stream;
    } else {
      streamId = this._clientStreamIdPair.get(clientId);
      if (streamId) {
        stream = this._remoteMediaStreams.get(streamId);
      }
    }

    if (stream) {
      debug(`Already had ${kind} for ${clientId}`);
      tracks = kind === "audio" ? stream.getAudioTracks() : stream.getVideoTracks();
      if (tracks) {
        const promise = Promise.resolve(new MediaStream(tracks));
        promise.catch(e => {
          this.emitRTCEvent("error", "Adapter", () => `getMediaStream error: ${e}`);
          console.warn(`${clientId} getMediaStream Error`, e);
        });
        return promise;
      }
    } else {
      console.log(`Waiting on ${kind} for ${clientId}`);
      debug(`Waiting on ${kind} for ${clientId}`);
      if (!this._pendingMediaRequests.has(clientId)) {
        this._pendingMediaRequests.set(clientId, {});
      }

      const requests = this._pendingMediaRequests.get(clientId);
      const promise = new Promise((resolve, reject) => (requests[kind] = { resolve, reject }));
      requests[kind].promise = promise;
      promise.catch(e => {
        this.emitRTCEvent("error", "Adapter", () => `getMediaStream error: ${e}`);
        console.warn(`${clientId} getMediaStream Error`, e);
      });
      return promise;
    }
  }

  getLocalMicTrack() {
    return this._sendrecv?.stream?.getAudioTracks()[0];
  }

  getLocalMediaStream() {
    return this._sendrecv?.stream;
  }

  async setLocalMediaStream(stream: MediaStream, videoContentHintByTrackId: Map<string, string> | null = null) {
    let sawAudio = false;
    let sawVideo = false;
    await Promise.all(
      stream.getTracks().map(async track => {
        if (track.kind === "audio") {
          sawAudio = true;
          if (!track.enabled || track.readyState === "ended" || track.id === this._localMediaStream?.getAudioTracks()[0].id) return;
          if (this._localMediaStream) {
            this._sendrecv?.replaceAudioTrack(this._localMediaStream, track.clone());
          }
        } else {
          sawVideo = true;
          const contentHint = videoContentHintByTrackId?.get(track.id);
          if (contentHint === MediaDevices.SCREEN) {
            await this.enableShare(track);
          } else if (contentHint === MediaDevices.CAMERA) {
            await this.enableCamera(track);
          }
        }
      })
    );

    if (!sawAudio) {
      
    }
    if (!sawVideo) {
      this.disableCamera();
      this.disableShare();
    }
  }

  toggleMicrophone() {
    if (this._micShouldBeEnabled) {
      this.enableMicrophone(false);
    } else {
      this.enableMicrophone(true);
    }
  }

  enableMicrophone(enabled: boolean) {
    if (this._sendrecv?.stream){
      this._sendrecv.stream.getAudioTracks().forEach(track => track.kind === "audio" && (track.enabled = enabled));
      this._micShouldBeEnabled = enabled;
      this.emit("mic-state-changed", { enabled: this._micShouldBeEnabled });
    }
  }

  get isMicEnabled() {
    return this._sendrecv?.audio === true
      && this._sendrecv?.stream?.getAudioTracks()[0]?.enabled === true
      && this._micShouldBeEnabled;
  }

  async enableCamera(track: MediaStreamTrack) {
    if (this._localMediaStream) {
      track.enabled = true;
      await this._sendrecv?.replaceVideoTrack(this._localMediaStream, track);
    }
    this._sendrecv?.on("removetrack", e => {
      if (e.track.kind === "video") {
        this.emitRTCEvent("info", "RTC", () => `Camera track ended`);
        this.disableCamera();
      }
    })
  }

  async disableCamera() {
    if (this._sendrecv?.stream) {
      this._sendrecv?.stopVideoTrack(this._sendrecv.stream);
    }
  }

  async enableShare(track: MediaStreamTrack) {
    if (this._localMediaStream) {
      track.enabled = true;
      await this._sendrecv?.replaceVideoTrack(this._localMediaStream, track);
    }
    this._sendrecv?.on("removetrack", e => {
      if (e.track.kind === "video") {
        this.emitRTCEvent("info", "RTC", () => `Desktop Share transport track ended`);
        this.disableCamera();
      }
    })
  }

  async disableShare() {
    if (this._sendrecv?.stream) {
      this._sendrecv?.stopVideoTrack(this._sendrecv.stream);
    }
  }

  kick(clientId: string) {
    document.body.dispatchEvent(new CustomEvent("kicked", { detail: { clientId: clientId } }));
  }

  block(clientId: string) {
    const streamId = this._clientStreamIdPair.get(clientId);
    if (streamId) {
      let stream = this._remoteMediaStreams.get(streamId);
      stream?.getTracks().forEach(track => {
        track.enabled = false;
      });
    }
    this._blockedClients.set(clientId, true);
    document.body.dispatchEvent(new CustomEvent("blocked", { detail: { clientId: clientId } }));
  }

  unblock(clientId: string) {
    const streamId = this._clientStreamIdPair.get(clientId);
    if (streamId) {
      let stream = this._remoteMediaStreams.get(streamId);
      stream?.getTracks().forEach(track => {
        track.enabled = true;
      });
    }
    this._blockedClients.delete(clientId);
    document.body.dispatchEvent(new CustomEvent("unblocked", { detail: { clientId: clientId } }));
  }

  emitRTCEvent(level: string, tag: string, msgFunc: () => void) {
    if (!window.APP.store.state.preferences.showRtcDebugPanel) return;
    const time = new Date().toLocaleTimeString("en-US", {
      hour12: false,
      hour: "numeric",
      minute: "numeric",
      second: "numeric"
    });
    // @ts-ignore
    this._scene?.emit("rtc_event", { level, tag, time, msg: msgFunc() });
  }

  resolvePendingMediaRequestForTrack(clientId: string) {
    const requests = this._pendingMediaRequests.get(clientId);
    const streamId = this._clientStreamIdPair.get(clientId);
    if (streamId) {
      const stream = this._remoteMediaStreams.get(streamId);
      if (stream && requests) {
        console.log("resolvePendingMediaRequestForTrack");
        if (requests["audio"]) {
          const resolve = requests["audio"].resolve;
          delete requests["audio"];
          resolve(new MediaStream(stream.getAudioTracks()));
        }
        if (requests["video"]) {
          const resolve = requests["video"].resolve;
          delete requests["video"];
          resolve(new MediaStream(stream.getVideoTracks()));
        }
      }
    }

    if (requests && Object.keys(requests).length === 0) {
      this._pendingMediaRequests.delete(clientId);
    }
  }

  startRecordStats() {
    this._recordStatsId = setInterval(async () => {
      (await this._sendrecv?.pc?.getStats())?.forEach((stat) => {
        if (stat.type === "outbound-rtp") sendStats.push(stat);
        if (stat.type === "inbound-rtp") recvStats.push(stat);
      });
    }, 3000);
  }

  stopRecordStats() {
    if (this._recordStatsId) clearInterval(this._recordStatsId);

    const sendStatsBlob = new Blob([JSON.stringify(sendStats)], { type: "text/json" });
    const sendStatslink = document.createElement("a");
    document.body.appendChild(sendStatslink);
    sendStatslink.href = window.URL.createObjectURL(sendStatsBlob);
    sendStatslink.setAttribute("download", "/sendStats.json");
    sendStatslink.click();
    document.body.removeChild(sendStatslink);

    const recvStatsBlob = new Blob([JSON.stringify(recvStats)], { type: "text/json" });
    const recvStatsLink = document.createElement("a");
    document.body.appendChild(recvStatsLink);
    recvStatsLink.href = window.URL.createObjectURL(recvStatsBlob);
    recvStatsLink.setAttribute("download", "/recvStats.json");
    recvStatsLink.click();
    document.body.removeChild(recvStatsLink);
  }
}
