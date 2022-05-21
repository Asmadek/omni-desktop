/* eslint-disable no-console */
import Olm from '@matrix-org/olm';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import olmWasmPath from '@matrix-org/olm/olm.wasm';
import {
  ClientEvent,
  createClient,
  EventType,
  IndexedDBCryptoStore,
  MatrixClient,
  MatrixEventEvent,
  MemoryCryptoStore,
  Preset,
  Room,
  RoomEvent,
  RoomMemberEvent,
  Visibility,
} from 'matrix-js-sdk';
import { SyncState } from 'matrix-js-sdk/lib/sync';
import { AuthState, OmniDexie } from '../db/db';
import {
  Callbacks,
  Membership,
  MstBaseParams,
  MSTCallbacks,
  MstCancelParams,
  MstInitParams,
  OmniMstEvents,
  RoomCreation,
  ISecureMessenger,
  Signatory,
  ValueOf,
} from './types';
import { BASE_URL, ROOM_CRYPTO_CONFIG } from './constants';

class Matrix implements ISecureMessenger {
  private static instance: Matrix;

  private matrixClient!: MatrixClient;
  private storage!: OmniDexie;

  private activeRoomId: string = '';
  private subscribeHandlers?: Callbacks;
  private isSynced: boolean = false;
  private isEncryptionActive: boolean = false;

  constructor(storage: OmniDexie) {
    if (Matrix.instance) {
      return Matrix.instance;
    }
    Matrix.instance = this;

    this.matrixClient = createClient({ baseUrl: BASE_URL });
    this.storage = storage;
  }

  // =====================================================
  // ================= Public methods ====================
  // =====================================================

  /**
   * Initialize Matrix protocol with encryption
   * @return {Promise}
   * @throws {Error}
   */
  async init(): Promise<void | never> {
    if (this.isEncryptionActive) {
      throw this.createError('Encryption has already been initialized');
    }

    try {
      await Olm.init({ locateFile: () => olmWasmPath });
      this.isEncryptionActive = true;
      console.info('=== 🟢 Olm started 🟢 ===');
    } catch (error) {
      throw this.createError('=== 🔴 Olm failed 🔴 ===', error);
    }
  }

  /**
   * Login user to Matrix
   * @param login login value
   * @param password password value
   * @return {Promise}
   * @throws {Error}
   */
  async loginWithCreds(login: string, password: string): Promise<void | never> {
    if (!this.isEncryptionActive) {
      throw this.createError('Encryption has not been initialized');
    }
    if (this.matrixClient.isLoggedIn()) {
      throw this.createError('Client is already logged in');
    }

    try {
      await this.initClientWithCreds(login, password);
      this.subscribeToEvents();
      await this.matrixClient.initCrypto();
      await this.matrixClient.startClient();
      this.matrixClient.setGlobalErrorOnUnknownDevices(false);
    } catch (error) {
      throw this.createError((error as Error).message, error);
    }
  }

  /**
   * Login user to Matrix with cached credentials
   * @return {Promise}
   * @throws {Error}
   */
  async loginFromCache(): Promise<void | never> {
    if (!this.isEncryptionActive) {
      throw this.createError('Encryption has not been initialized');
    }
    if (this.matrixClient.isLoggedIn()) {
      throw this.createError('Client is already logged in');
    }

    try {
      await this.initClientFromCache();
      this.subscribeToEvents();
      await this.matrixClient.initCrypto();
      await this.matrixClient.startClient();
      this.matrixClient.setGlobalErrorOnUnknownDevices(false);
    } catch (error) {
      throw this.createError((error as Error).message, error);
    }
  }

  /**
   * Is Matrix user logged in
   * @return {Boolean}
   */
  get isLoggedIn(): boolean {
    return Boolean(this.matrixClient.isLoggedIn());
  }

  /**
   * Stop the client and remove handlers
   * @return {Promise}
   * @throws {Error}
   */
  stopClient(): void | never {
    this.checkClientLoggedIn();

    this.matrixClient.stopClient();
    this.clearSubscribers();
    this.matrixClient = createClient(BASE_URL);
  }

  /**
   * Logout user from Matrix,
   * terminate client,
   * stop synchronization polling
   * @return {Promise}
   * @throws {Error}
   */
  async logout(): Promise<void | never> {
    this.checkClientLoggedIn();

    try {
      await this.matrixClient.logout();
      this.matrixClient.stopClient();
      this.clearSubscribers();
      // await this.matrixClient.clearStores();
      await this.storage.matrixCredentials
        .where({ userId: this.matrixUserId })
        .delete();
      this.matrixClient = createClient(BASE_URL);
    } catch (error) {
      throw this.createError('Logout failed', error);
    }
  }

  /**
   * Create a room for new MST account
   * @param params room configuration
   * @param signWithColdWallet create signature with cold wallet
   * @return {Promise}
   * @throws {Error}
   */
  async createRoom(
    params: RoomCreation,
    signWithColdWallet: (value: string) => Promise<string>,
  ): Promise<void | never> {
    this.checkClientLoggedIn();

    try {
      const { room_id: roomId } = await this.matrixClient.createRoom({
        name: `OMNI MST | ${params.mstAccountAddress}`,
        visibility: Visibility.Private,
        preset: Preset.TrustedPrivateChat,
      });

      const signature = await signWithColdWallet(
        `${params.mstAccountAddress}${roomId}`,
      );
      await this.initialStateEvents(roomId, params, signature);
      await this.inviteSignatories(roomId, params.signatories);

      const members = params.signatories.map(
        (signatory) => signatory.matrixAddress,
      );
      await this.verifyDevices(members);
    } catch (error) {
      throw this.createError((error as Error).message, error);
    }
  }

  /**
   * Join existing MST room
   * @param roomId room's identifier
   * @return {Promise}
   * @throws {Error}
   */
  async joinRoom(roomId: string): Promise<void | never> {
    this.checkClientLoggedIn();

    try {
      await this.matrixClient.joinRoom(roomId);
    } catch (error) {
      throw this.createError(`Failed to join room - ${roomId}`, error);
    }
  }

  /**
   * Invite signatory to existing MST room
   * @param roomId room's identifier
   * @param signatoryId signatory's identifier
   * @return {Promise}
   * @throws {Error}
   */
  async invite(roomId: string, signatoryId: string): Promise<void | never> {
    this.checkClientLoggedIn();

    try {
      await this.matrixClient.invite(roomId, signatoryId);
    } catch (error) {
      throw this.createError(
        `Failed to invite - ${signatoryId} to room - ${roomId}`,
        error,
      );
    }
  }

  /**
   * List of available OMNI rooms
   * @param type which rooms to get Invite/Join
   * @return {Array}
   */
  listOfOmniRooms(type: Membership.INVITE | Membership.JOIN): Room[] {
    this.checkClientLoggedIn();

    return this.matrixClient
      .getRooms()
      .filter(
        (room) => this.isOmniRoom(room.name) && room.getMyMembership() === type,
      );
  }

  /**
   * Set active room id
   * @param roomId room's identifier
   */
  setRoom(roomId: string): void {
    this.activeRoomId = roomId;
  }

  /**
   * Get timeline events for active room
   * @return {Array}
   * @throws {Error}
   */
  timelineMessages(): Record<string, unknown>[] | never {
    const room = this.getActiveRoom(this.activeRoomId);

    const timelineEvents = room.getLiveTimeline().getEvents();
    return timelineEvents.map((event) => {
      console.log(`===> 🔶 TYPE - ${event.getType()}`);
      return event.getContent();
    });
  }

  /**
   * Send message to active room
   * @param message sending message
   * @return {Promise}
   */
  async sendMessage(message: string): Promise<void> {
    this.checkClientLoggedIn();
    this.checkInsideRoom();

    try {
      await this.matrixClient.sendTextMessage(this.activeRoomId, message);
    } catch (error) {
      throw this.createError('Message not sent', error);
    }
  }

  /**
   * Setup subscription
   * @param handlers aggregated callback handlers
   */
  setupSubscribers(handlers: Callbacks): void {
    this.subscribeHandlers = handlers;
  }

  /**
   * Clear subscription
   */
  clearSubscribers(): void {
    this.matrixClient.removeAllListeners();
    this.subscribeHandlers = undefined as unknown as Callbacks;
  }

  /**
   * Check does User already exist
   * @param userId matrix identifier
   * @return {Promise}
   * @throws {Error}
   */
  async checkUserExists(userId: string): Promise<boolean | never> {
    if (!this.matrixClient) {
      throw this.createError('Client is not active');
    }

    const userName = userId.match(/^@([a-z\d=_\-./]+):/);
    if (!userName) {
      throw new Error('User ID can only contain characters a-z, 0-9, or =_-./');
    }

    try {
      return await this.matrixClient.isUsernameAvailable(userName?.[1]);
    } catch (error) {
      throw this.createError((error as Error).message, error);
    }
  }

  /**
   * Send MST_INIT state event to the room
   * Initialize multi-sig transaction
   * @param params MST parameters
   * @return {Promise}
   * @throws {Error}
   */
  async mstInitiate(params: MstInitParams): Promise<void | never> {
    this.checkClientLoggedIn();
    this.checkInsideRoom();

    try {
      await this.matrixClient.sendEvent(
        this.activeRoomId,
        OmniMstEvents.INIT,
        params,
      );
    } catch (error) {
      throw this.createError('MST_INIT failed', error);
    }
  }

  /**
   * Send MST_APPROVE state event to the room
   * Approve multi-sig transaction
   * @param params MST parameters
   * @return {Promise}
   * @throws {Error}
   */
  async mstApprove(params: MstBaseParams): Promise<void | never> {
    this.checkClientLoggedIn();
    this.checkInsideRoom();

    try {
      await this.matrixClient.sendEvent(
        this.activeRoomId,
        OmniMstEvents.APPROVE,
        params,
      );
    } catch (error) {
      throw this.createError('MST_APPROVE failed', error);
    }
  }

  /**
   * Send MST_FINAL_APPROVE state event to the room
   * Final approve for multi-sig transaction
   * @param params MST parameters
   * @return {Promise}
   * @throws {Error}
   */
  async mstFinalApprove(params: MstBaseParams): Promise<void | never> {
    this.checkClientLoggedIn();
    this.checkInsideRoom();

    try {
      await this.matrixClient.sendEvent(
        this.activeRoomId,
        OmniMstEvents.FINAL_APPROVE,
        params,
      );
    } catch (error) {
      throw this.createError('MST_FINAL_APPROVE failed', error);
    }
  }

  /**
   * Send MST_CANCEL state event to the room
   * Cancel multi-sig transaction
   * @param params MST parameters
   * @return {Promise}
   * @throws {Error}
   */
  async mstCancel(params: MstCancelParams): Promise<void | never> {
    this.checkClientLoggedIn();
    this.checkInsideRoom();

    try {
      await this.matrixClient.sendEvent(
        this.activeRoomId,
        OmniMstEvents.CANCEL,
        params,
      );
    } catch (error) {
      throw this.createError('MST_CANCEL failed', error);
    }
  }

  // =====================================================
  // ================= Private methods ===================
  // =====================================================

  private async initialStateEvents(
    roomId: string,
    params: RoomCreation,
    signature: string,
  ): Promise<void> {
    await this.matrixClient.sendStateEvent(
      roomId,
      'm.room.encryption',
      ROOM_CRYPTO_CONFIG,
    );

    const omniExtras = {
      mst_account: {
        threshold: params.threshold,
        signatories: params.signatories.map(
          (signatory) => signatory.networkAddress,
        ),
        address: params.mstAccountAddress,
      },
      invite: {
        signature,
        public_key: params.inviterPublicKey,
      },
    };

    const topicContent = {
      topic: `Room for communications for ${params.mstAccountAddress} MST account`,
      omni_extras: omniExtras,
    };

    await this.matrixClient.sendStateEvent(
      roomId,
      'm.room.topic',
      topicContent,
    );
  }

  private async inviteSignatories(
    roomId: string,
    signatories: Signatory[],
  ): Promise<void> {
    const inviteRequests = signatories
      .filter((signatory) => !signatory.isInviter)
      .reduce((acc, signatory) => {
        acc.push(this.matrixClient.invite(roomId, signatory.matrixAddress));

        return acc;
      }, [] as Promise<unknown>[]);

    await Promise.all(inviteRequests);
  }

  private async verifyDevices(members: string[]): Promise<void | never> {
    const memberKeys = await this.matrixClient.downloadKeys(members);

    const verifyRequests = members.reduce((acc, userId) => {
      Object.keys(memberKeys[userId]).forEach((deviceId) => {
        acc.push(this.matrixClient.setDeviceVerified(userId, deviceId));
      });
      return acc;
    }, [] as Promise<void>[]);

    await Promise.all(verifyRequests);
    console.info('=== 🟢 Devices verified');
  }

  private async initClientWithCreds(
    login: string,
    password: string,
  ): Promise<void | never> {
    const userLoginResult = await this.matrixClient.loginWithPassword(
      login,
      password,
    );

    this.matrixClient = createClient({
      baseUrl: BASE_URL,
      userId: userLoginResult.user_id,
      accessToken: userLoginResult.access_token,
      deviceId: userLoginResult.device_id,
      sessionStore: new MemoryCryptoStore(),
      cryptoStore: new IndexedDBCryptoStore(window.indexedDB, 'matrix'),
    });

    await this.storage.matrixCredentials.add({
      userId: userLoginResult.user_id,
      accessToken: userLoginResult.access_token,
      deviceId: userLoginResult.device_id,
      isLoggedIn: AuthState.LOGGED_IN,
    });
  }

  private async initClientFromCache(): Promise<void | never> {
    const credentials = await this.storage.matrixCredentials.get({
      isLoggedIn: AuthState.LOGGED_IN,
    });

    if (!credentials) {
      throw new Error('No credentials in DataBase');
    }

    this.matrixClient = createClient({
      baseUrl: BASE_URL,
      userId: credentials.userId,
      accessToken: credentials.accessToken,
      deviceId: credentials.deviceId,
      sessionStore: new MemoryCryptoStore(),
      cryptoStore: new IndexedDBCryptoStore(window.indexedDB, 'matrix'),
    });
  }

  private subscribeToEvents(): void {
    this.handleSyncEvent();
    this.handleInviteEvent();
    this.handleMatrixEvents();
    this.handleOmniEvents();
  }

  private handleSyncEvent() {
    this.matrixClient.on(ClientEvent.Sync, (state) => {
      if (state === SyncState.Syncing) {
        this.subscribeHandlers?.onSyncProgress();
      }
      if (state === SyncState.Prepared) {
        console.info('=== 🏁 Sync prepared');
        this.isSynced = true;
        this.subscribeHandlers?.onSyncEnd();
      }
    });
  }

  private handleInviteEvent(): void {
    this.matrixClient.on(
      RoomMemberEvent.Membership,
      async (_, { roomId, userId, membership, name }) => {
        if (!this.isSynced) return;

        const isValidUser =
          userId === this.matrixClient.getUserId() &&
          membership === Membership.INVITE;
        if (isValidUser && this.isOmniRoom(name)) {
          this.subscribeHandlers?.onInvite(roomId);
        }
      },
    );
  }

  private handleMatrixEvents(): void {
    this.matrixClient.on(MatrixEventEvent.Decrypted, async (event) => {
      if (!this.isSynced) return;

      if (event.getType() !== EventType.RoomMessage) return;

      const roomId = event.getRoomId();
      if (!roomId) return;

      const room = this.matrixClient.getRoom(roomId);
      if (!room || !this.isOmniRoom(room.name)) return;

      console.log(`=== 🟢 new event ${event.getType()} - ${room.name} ===`);
      console.log(`=== 🟢 message ${event.getContent().body} ===`);

      this.subscribeHandlers?.onMessage(event.getContent().body);
    });
  }

  private handleOmniEvents(): void {
    const callbacks: Record<OmniMstEvents, ValueOf<MSTCallbacks> | undefined> =
      {
        [OmniMstEvents.INIT]: this.subscribeHandlers?.onMstInitiate,
        [OmniMstEvents.APPROVE]: this.subscribeHandlers?.onMstApprove,
        [OmniMstEvents.FINAL_APPROVE]:
          this.subscribeHandlers?.onMstFinalApprove,
        [OmniMstEvents.CANCEL]: this.subscribeHandlers?.onMstCancel,
      };

    this.matrixClient.on(RoomEvent.Timeline, (event) => {
      if (!this.isSynced) return;

      const roomId = event.getRoomId();
      if (!roomId) return;

      const room = this.matrixClient.getRoom(roomId);
      if (!room || !this.isOmniRoom(room.name)) return;

      callbacks[event.getType() as OmniMstEvents]?.({
        roomId: event.getRoomId(),
        sender: event.getSender(),
        content: event.getContent(),
        date: event.getDate(),
      });
    });
  }

  // =====================================================
  // ====================== Helpers ======================
  // =====================================================

  /**
   * Create error object with a provided message
   * @param message error's message value
   * @param error optional error object
   * @return {Error}
   */
  private createError(message: string, error?: unknown): Error {
    const typedError =
      error instanceof Error
        ? error
        : new Error('Error: ', { cause: error as Error });

    return new Error(`🔶 Matrix: ${message} 🔶`, { cause: typedError });
  }

  /**
   * Verify that user is logged in
   * @param message error's message value
   * @throws {Error}
   */
  private checkClientLoggedIn(message?: string): void | never {
    if (!this.matrixClient.isLoggedIn()) {
      const throwMsg = message
        ? `🔶 ${message} 🔶`
        : '🔶 Matrix client is not logged in 🔶';
      throw new Error(throwMsg);
    }
  }

  /**
   * Verify that user is inside room
   * @param message error's message value
   * @throws {Error}
   */
  private checkInsideRoom(message?: string): void | never {
    if (!this.activeRoomId) {
      const throwMsg = message
        ? `🔶 ${message} 🔶`
        : '🔶 Matrix client is outside of room 🔶';
      throw new Error(throwMsg);
    }
  }

  /**
   * Get active room
   * @param roomId room's identifier
   * @return {Room}
   * @throws {Error}
   */
  private getActiveRoom(roomId: string): Room | never {
    const room = this.matrixClient.getRoom(roomId);
    if (room) return room;

    throw new Error('Room not found');
  }

  /**
   * Check room name to be an Omni room
   * @param roomName name of the room
   * @return {Boolean}
   */
  private isOmniRoom(roomName?: string): boolean {
    if (!roomName) return false;

    return /^OMNI MST \| 0x[a-fA-F\d]+$/.test(roomName);
  }

  /**
   * Get matrix userId
   * @return {string}
   */
  private get matrixUserId(): string {
    return this.matrixClient.getUserId();
  }
}

export default Matrix;
