# lightshow

Turn an audience's phones into a synchronised crowd light show. No app install or hardware wristbands required.

A host draws the venue, drops in an audio track and paints light effects onto a timeline, or generates a full show from the music. At the event, participants scan a QR code on the big screen, point their phone camera at the screen to locate their seat, and play back their pre-computed light schedule in sync over WebSockets.

[Visit lightshow.party](https://lightshow.party)

[![lightshow host room showing the effects library, 120 ready seats and a multi-track timeline](docs/media/editor.png)](docs/media/editor.png)

Built for the **2026 Tanda Hackathon**.

| Team                                                             | Contribution                                                                |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Etao · [@wetsocksnsleeves](https://github.com/wetsocksnsleeves)  | Sync engine, schedule compiler, audio-reactive generator and built-in shows |
| William · [@williamjaackson](https://github.com/williamjaackson) | Camera seat positioning, rooms editor and crowd recording                   |
| Chloe · [@clobothehobo](https://github.com/clobothehobo)         | Host room design, branding and built-in tracks                              |
| Lliam · [@lliamsymonds04](https://github.com/lliamsymonds04)     | 3D crowd viewer and Fly.io deployment                                       |
| Farzad · [@FarzadHayat](https://github.com/FarzadHayat)          | Pitch deck stage lighting and demo show                                     |

## Big screen QR code and camera seat finding

Every audience phone needs to know where it is in the room without typing a row or seat number. The big screen (`/sessions/<code>/screen`) handles both joining and positioning in one view:

- **Join QR code** in the centre opens the participant page straight in the phone's browser.
- **Four corner anchors** (rounded finder squares) let the phone's camera lock onto the screen from anywhere in the room.
- **Rotation-unique LED grille** (~300 lit and unlit dots) identifies each corner regardless of phone orientation and gives hundreds of matched points to solve the camera's 3D position in metres.

After scanning the QR code, a participant taps **Find my seat**, points their phone back at the big screen for a second until the green lock completes, checks their spot on the room map, and taps **Ready**. The phone then enters fullscreen, requests a wake lock, runs a clock-sync handshake over WebSockets, and downloads its own pre-computed light schedule.

<table>
  <tr>
    <td width="72%"><a href="docs/media/big-screen.png"><img src="docs/media/big-screen.png" alt="Big screen positioning target with four corner anchors, LED grille and join QR code" /></a></td>
    <td width="28%"><a href="docs/demo/phone-setup.gif"><img src="docs/demo/phone-setup.gif" alt="Mobile phone setup demo using a virtual camera pointed at the big screen target" /></a></td>
  </tr>
</table>

Point at the big screen → seat solved in metres → synced and ready.

<p>
  <a href="docs/media/phone-scan.png"><img src="docs/media/phone-scan.png" width="220" alt="Phone camera locking onto the four corner anchors and QR target on the big screen" /></a>
  <a href="docs/media/phone-found.png"><img src="docs/media/phone-found.png" width="220" alt="Seat found on the room map, 3.4 m from the screen and 1.2 m left of centre" /></a>
  <a href="docs/media/phone-ready.png"><img src="docs/media/phone-ready.png" width="220" alt="Phone in green standby screen ready for playback" /></a>
</p>

## Studio and 3D preview

Layer flashes, waves, splits, chases and custom shapes over an audio waveform, or auto-generate a show from three-band frequency analysis. Before showtime, open `/mock` to simulate a crowd joining and watch the whole venue play back in 3D.

| Editor and multi-track timeline                                        | Simulated phones joining a room                                                                     |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [![Editor view](docs/demo/editor-view.gif)](docs/demo/editor-view.gif) | [![Simulated phones joining a session](docs/demo/mock-demo-join.gif)](docs/demo/mock-demo-join.gif) |

| Live playback from the host room                                                                      | Bird's-eye 3D crowd view                                                                        |
| ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| [![Editor preview playing back live](docs/demo/live-show-editor.gif)](docs/demo/live-show-editor.gif) | [![3D venue view during live playback](docs/demo/mock-3d-live.gif)](docs/demo/mock-3d-live.gif) |

## Run locally

Built with Next.js, TypeScript, Node.js (`ws`) and SQLite. Requires Node.js 24+.

```sh
git clone https://github.com/wetsocksnsleeves/lightshow.git
cd lightshow
npm ci
npm run dev
```

Open [localhost:3000](http://localhost:3000) to open a host room, then open [localhost:3000/mock](http://localhost:3000/mock) in another tab to simulate phones joining in 3D.

To test with real phones over HTTPS (required for camera access and screen wake lock), copy `.env.example` to `.env` and set `PUBLIC_URL` to your tunnel or public HTTPS address.

[Spec](SPEC.md) · [Development plan](DEVELOPMENT.md) · [Device testing](docs/device-test.md)

## License

[O'Saasy License](LICENSE.md)
