import 'dart:convert';

import 'package:dio/dio.dart';
import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';
import 'package:image_picker/image_picker.dart';

import '../../app/theme.dart';
import '../../core/providers.dart';
import '../../core/widgets/api_image.dart';
import '../../core/widgets/section_header.dart';
import '../aadhaar/aadhaar_decoder.dart';
import '../aadhaar/aadhaar_verify_screen.dart';
import '../printing/badge_printer.dart';
import '../printing/print_cards.dart';

/// Safety-officer worker registration / editing — full parity with the admin
/// panel form. IDs (W-/S-/V-####) are always auto-generated and immutable;
/// the QR badge is derived from the ID, so no credential input is needed.
class WorkerEditScreen extends ConsumerStatefulWidget {
  const WorkerEditScreen({super.key, this.workerId, this.initialCategory = 'WORKER'});

  /// Null = create new.
  final String? workerId;

  /// What the "Add" button opened: WORKER, STAFF or VISITOR. Ignored on edit —
  /// the stored category wins.
  final String initialCategory;

  @override
  ConsumerState<WorkerEditScreen> createState() => _WorkerEditScreenState();
}

class _WorkerEditScreenState extends ConsumerState<WorkerEditScreen> {
  final _formKey = GlobalKey<FormState>();

  // Identity
  final _name = TextEditingController();
  final _fatherName = TextEditingController();
  final _language = TextEditingController();
  final _mobile = TextEditingController();
  final _pincode = TextEditingController();
  final _bloodGroup = TextEditingController();
  // Emergency & nominee
  final _emergencyName = TextEditingController();
  final _emergencyNumber = TextEditingController();
  final _nomineeName = TextEditingController();
  final _nomineeRelation = TextEditingController();
  // Screening & ID card
  final _screeningBy = TextEditingController();
  final _inductedBy = TextEditingController();
  // Bank & statutory
  final _bankName = TextEditingController();
  final _bankAccount = TextEditingController();
  final _ifsc = TextEditingController();
  final _pf = TextEditingController();
  final _esi = TextEditingController();
  // Work
  final _natureOfContractor = TextEditingController();
  final _aadhaar = TextEditingController();
  final _pan = TextEditingController();
  // Visitor
  final _escortName = TextEditingController();
  final _visitorCompany = TextEditingController();

  late String _category = widget.initialCategory;
  String? _companyName;
  String? _gender;
  String? _status;
  DateTime? _dob;
  DateTime? _joinDate;
  DateTime? _screeningOn;
  DateTime? _inductionOn;
  DateTime? _validityTill;
  String? _designationId;
  String? _vendorId;
  String? _photoUrl;
  String? _aadhaarFrontPhotoId;
  String? _aadhaarBackPhotoId;
  String? _idProofPhotoId;
  String _workerCode = '';
  bool _saving = false;
  bool _uploadingPhoto = false;
  bool _uploadingAadhaar = false;
  bool _uploadingIdProof = false;
  bool _loading = true;
  String? _error;

  List<Map<String, dynamic>> _designations = [];
  List<Map<String, dynamic>> _vendors = [];
  List<Map<String, dynamic>> _sites = [];
  String? _siteId;
  String? _siteName;

  /// The site this person was already assigned to when the form opened. On edit
  /// we only re-assign when the picker actually moves off it.
  String? _initialSiteId;
  Map<String, dynamic>? _existing;

  bool get _isEdit => widget.workerId != null;
  bool get _isVisitor => _category == 'VISITOR';

  /// Staff are the company's own people: the employer is captured automatically
  /// and we keep only the minimum on file — no bank, nominee or Gov ID.
  bool get _isStaff => _category == 'STAFF';

  @override
  void initState() {
    super.initState();
    Future.microtask(_load);
  }

  @override
  void dispose() {
    for (final c in [
      _name,
      _fatherName,
      _language,
      _mobile,
      _pincode,
      _bloodGroup,
      _emergencyName,
      _emergencyNumber,
      _nomineeName,
      _nomineeRelation,
      _screeningBy,
      _inductedBy,
      _bankName,
      _bankAccount,
      _ifsc,
      _pf,
      _esi,
      _natureOfContractor,
      _aadhaar,
      _pan,
      _escortName,
      _visitorCompany,
    ]) {
      c.dispose();
    }
    super.dispose();
  }

  Future<void> _load() async {
    final db = ref.read(localDbProvider);
    _siteId = await db.getMeta('active_site');
    _siteName = await db.getMeta('active_site_name');
    final dio = ref.read(apiClientProvider).dio;
    try {
      final results = await Future.wait([
        dio.get('/designations'),
        dio.get('/vendors'),
        dio.get('/organizations/current'),
        dio.get('/sites', queryParameters: {'active': 'true'}),
        if (_isEdit) dio.get('/workers/${widget.workerId}'),
      ]);
      _designations = (results[0].data as List).cast<Map<String, dynamic>>();
      _vendors = (results[1].data as List)
          .cast<Map<String, dynamic>>()
          .where((v) => v['isActive'] != false)
          .toList();
      // Staff work for us, not a contractor — read the company name rather than
      // hard-coding it, so a rename in Company settings follows through.
      _companyName = (results[2].data as Map<String, dynamic>)['name'] as String?;
      _sites = (results[3].data as List).cast<Map<String, dynamic>>();
      if (_isEdit) {
        final w = results[4].data as Map<String, dynamic>;
        _existing = w;
        _workerCode = (w['workerCode'] ?? '') as String;
        _name.text = (w['fullName'] ?? '') as String;
        _fatherName.text = (w['fatherName'] as String?) ?? '';
        _language.text = (w['language'] as String?) ?? '';
        _mobile.text = (w['mobileNumber'] as String?) ?? '';
        _pincode.text = (w['pincode'] as String?) ?? '';
        _bloodGroup.text = (w['bloodGroup'] as String?) ?? '';
        _emergencyName.text = (w['emergencyContactName'] as String?) ?? '';
        _emergencyNumber.text = (w['emergencyContactNumber'] as String?) ?? '';
        _nomineeName.text = (w['nomineeName'] as String?) ?? '';
        _nomineeRelation.text = (w['nomineeRelation'] as String?) ?? '';
        _screeningBy.text = (w['screeningDoneBy'] as String?) ?? '';
        _inductedBy.text = (w['inductedBy'] as String?) ?? '';
        final soStr = w['screeningDoneOn'] as String?;
        if (soStr != null) _screeningOn = DateTime.tryParse(soStr);
        final ioStr = w['inductionDoneOn'] as String?;
        if (ioStr != null) _inductionOn = DateTime.tryParse(ioStr);
        final vtStr = w['validityTill'] as String?;
        if (vtStr != null) _validityTill = DateTime.tryParse(vtStr);
        _bankName.text = (w['bankName'] as String?) ?? '';
        _bankAccount.text = (w['bankAccountNumber'] as String?) ?? '';
        _ifsc.text = (w['ifscCode'] as String?) ?? '';
        _pf.text = (w['pfNumber'] as String?) ?? '';
        _esi.text = (w['esiNumber'] as String?) ?? '';
        _natureOfContractor.text = (w['natureOfContractor'] as String?) ?? '';
        _category = (w['category'] as String?) ?? 'WORKER';
        _gender = w['gender'] as String?;
        _status = w['status'] as String?;
        _designationId = w['designationId'] as String?;
        _vendorId = w['vendorId'] as String?;
        // On edit the picker shows where this person actually is, not whatever
        // site this device happens to be set to.
        final assignments = (w['assignments'] as List?) ?? const [];
        final assignment =
            assignments.isEmpty ? null : assignments.first as Map<String, dynamic>;
        _siteId = assignment?['siteId'] as String?;
        _siteName = (assignment?['site'] as Map<String, dynamic>?)?['name'] as String?;
        _initialSiteId = _siteId;
        _photoUrl = w['photoUrl'] as String?;
        _aadhaarFrontPhotoId = w['aadhaarFrontPhotoId'] as String?;
        _aadhaarBackPhotoId = w['aadhaarBackPhotoId'] as String?;
        _escortName.text = (w['escortName'] as String?) ?? '';
        _visitorCompany.text = (w['visitorCompany'] as String?) ?? '';
        _idProofPhotoId = w['idProofPhotoId'] as String?;
        final dobStr = w['dateOfBirth'] as String?;
        if (dobStr != null) _dob = DateTime.tryParse(dobStr);
      }
      if (mounted) setState(() => _loading = false);
    } on DioException catch (e) {
      if (mounted) {
        setState(() {
          _error = _friendlyError(e, 'Failed to load form data');
          _loading = false;
        });
      }
    }
  }

  String _friendlyError(DioException e, String fallback) {
    final data = e.response?.data;
    final detail = data is Map ? (data['detail'] ?? data['title']) : null;
    if (detail is String && detail.isNotEmpty) return detail;
    if (e.response?.statusCode == 403) {
      return 'Your account does not have permission for this — ask an admin to check your role.';
    }
    return e.message ?? fallback;
  }

  Future<void> _pickPhoto(ImageSource source) async {
    final picked = await ImagePicker().pickImage(
      source: source,
      maxWidth: 800,
      maxHeight: 800,
      imageQuality: 75,
    );
    if (picked == null) return;
    setState(() => _uploadingPhoto = true);
    try {
      final bytes = await picked.readAsBytes();
      final dio = ref.read(apiClientProvider).dio;
      final res = await dio.post('/files', data: {
        'dataBase64': base64Encode(bytes),
        'mimeType': 'image/jpeg',
      });
      if (mounted) setState(() => _photoUrl = res.data['url'] as String);
    } on DioException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Photo upload failed: ${e.message ?? 'network'}')),
        );
      }
    } finally {
      if (mounted) setState(() => _uploadingPhoto = false);
    }
  }

  /// Capture/upload a document image (Aadhaar card faces or visitor ID proof).
  /// Larger than the profile photo so the card text/QR stay legible; the
  /// server compresses + encrypts it at rest.
  Future<void> _pickDocument(ImageSource source, String kind) async {
    final picked = await ImagePicker().pickImage(
      source: source,
      maxWidth: 1600,
      maxHeight: 1600,
      imageQuality: 82,
    );
    if (picked == null) return;
    final isIdProof = kind == 'ID_PROOF';
    setState(() => isIdProof ? _uploadingIdProof = true : _uploadingAadhaar = true);
    try {
      final bytes = await picked.readAsBytes();
      final dio = ref.read(apiClientProvider).dio;
      final res = await dio.post('/files', data: {
        'dataBase64': base64Encode(bytes),
        'mimeType': 'image/jpeg',
        'kind': kind,
      });
      final id = res.data['id'] as String;
      if (mounted) {
        setState(() {
          switch (kind) {
            case 'AADHAAR_FRONT':
              _aadhaarFrontPhotoId = id;
            case 'AADHAAR_BACK':
              _aadhaarBackPhotoId = id;
            case 'ID_PROOF':
              _idProofPhotoId = id;
          }
        });
      }
    } on DioException catch (e) {
      if (mounted) {
        ScaffoldMessenger.of(context).showSnackBar(
          SnackBar(content: Text('Upload failed: ${e.message ?? 'network'}')),
        );
      }
    } finally {
      if (mounted) {
        setState(() => isIdProof ? _uploadingIdProof = false : _uploadingAadhaar = false);
      }
    }
  }

  void _chooseDocumentSource(String kind) {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera),
              title: const Text('Take photo'),
              onTap: () {
                Navigator.pop(ctx);
                _pickDocument(ImageSource.camera, kind);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library),
              title: const Text('Choose from gallery'),
              onTap: () {
                Navigator.pop(ctx);
                _pickDocument(ImageSource.gallery, kind);
              },
            ),
          ],
        ),
      ),
    );
  }

  Widget _documentTile(String label, String kind, String? id, bool uploading) {
    return Expanded(
      child: Column(
        children: [
          GestureDetector(
            onTap: uploading ? null : () => _chooseDocumentSource(kind),
            child: Container(
              height: 70,
              decoration: BoxDecoration(
                border: Border.all(color: Theme.of(context).dividerColor),
                borderRadius: BorderRadius.circular(8),
              ),
              alignment: Alignment.center,
              child: id != null
                  ? ApiCircleAvatar(photoUrl: '/files/$id', radius: 28)
                  : const Icon(Icons.add_a_photo_outlined),
            ),
          ),
          const SizedBox(height: 4),
          OutlinedButton(
            onPressed: uploading ? null : () => _chooseDocumentSource(kind),
            child: Text(id == null ? label : 'Replace $label'),
          ),
        ],
      ),
    );
  }

  void _choosePhotoSource() {
    showModalBottomSheet(
      context: context,
      builder: (ctx) => SafeArea(
        child: Wrap(
          children: [
            ListTile(
              leading: const Icon(Icons.photo_camera),
              title: const Text('Take photo'),
              onTap: () {
                Navigator.pop(ctx);
                _pickPhoto(ImageSource.camera);
              },
            ),
            ListTile(
              leading: const Icon(Icons.photo_library),
              title: const Text('Choose from gallery'),
              onTap: () {
                Navigator.pop(ctx);
                _pickPhoto(ImageSource.gallery);
              },
            ),
            if (_photoUrl != null)
              ListTile(
                leading: const Icon(Icons.delete_outline),
                title: const Text('Remove photo'),
                onTap: () {
                  Navigator.pop(ctx);
                  setState(() => _photoUrl = null);
                },
              ),
          ],
        ),
      ),
    );
  }

  Future<void> _scanAadhaar() async {
    final data = await Navigator.of(context).push<AadhaarData>(
      MaterialPageRoute(builder: (_) => const AadhaarVerifyScreen(popWithResult: true)),
    );
    if (data == null || !mounted) return;
    setState(() {
      if (data.name != null && _name.text.isEmpty) _name.text = data.name!;
      if (data.careOf != null && _fatherName.text.isEmpty) {
        // "S/O Xyz" — strip the relation prefix when present.
        _fatherName.text = data.careOf!.replaceFirst(RegExp(r'^[SDWC]/O:?\s*'), '');
      }
      if (data.gender != null) {
        _gender = data.gender == 'M' || data.gender == 'F' ? data.gender : 'OTHER';
      }
      final iso = data.dobIso;
      if (iso != null) _dob = DateTime.tryParse(iso);
      if (data.pincode != null && _pincode.text.isEmpty) _pincode.text = data.pincode!;
    });
    ScaffoldMessenger.of(context).showSnackBar(
      const SnackBar(
        content: Text(
          'Details filled from Aadhaar QR. The full Aadhaar number is not in the QR — '
          'enter it manually if required.',
        ),
      ),
    );
  }

  Future<void> _save() async {
    if (!(_formKey.currentState?.validate() ?? false)) return;
    // Registering somebody without a site leaves them belonging to none: absent
    // from the Safety Officer's list, and absent from the offline cache that
    // list fills, so they can be scanned while the tablet has signal and not at
    // all once it drops. This normally defaults to the site picked at sign-in,
    // so it can only be empty if that never happened.
    if (!_isEdit && (_siteId == null || _siteId!.isEmpty)) {
      setState(() => _error = 'Pick the site this person works at.');
      return;
    }
    setState(() {
      _saving = true;
      _error = null;
    });
    final dio = ref.read(apiClientProvider).dio;

    String? text(TextEditingController c) {
      final v = c.text.trim();
      return v.isEmpty ? null : v;
    }

    final body = <String, dynamic>{
      'fullName': _name.text.trim(),
      'category': _category,
      if (!_isVisitor && text(_fatherName) != null) 'fatherName': text(_fatherName),
      if (_gender != null) 'gender': _gender,
      if (!_isVisitor && _dob != null)
        'dateOfBirth': _dob!.toIso8601String().substring(0, 10),
      if (!_isVisitor && text(_language) != null) 'language': text(_language),
      if (text(_mobile) != null) 'mobileNumber': text(_mobile),
      if (!_isVisitor && !_isStaff && text(_pincode) != null) 'pincode': text(_pincode),
      if (text(_bloodGroup) != null) 'bloodGroup': text(_bloodGroup),
      if (text(_emergencyName) != null) 'emergencyContactName': text(_emergencyName),
      if (text(_emergencyNumber) != null) 'emergencyContactNumber': text(_emergencyNumber),
      if (!_isStaff && text(_nomineeName) != null) 'nomineeName': text(_nomineeName),
      if (!_isStaff && text(_nomineeRelation) != null) 'nomineeRelation': text(_nomineeRelation),
      // Induction only — screening is the same step.
      if (!_isVisitor) ...{
        if (_inductionOn != null)
          'inductionDoneOn': _inductionOn!.toIso8601String().substring(0, 10),
        if (text(_inductedBy) != null) 'inductedBy': text(_inductedBy),
        if (_validityTill != null)
          'validityTill': _validityTill!.toIso8601String().substring(0, 10),
      },
      if (!_isStaff) ...{
        if (text(_bankName) != null) 'bankName': text(_bankName),
        if (text(_bankAccount) != null) 'bankAccountNumber': text(_bankAccount),
        if (text(_ifsc) != null) 'ifscCode': text(_ifsc),
        if (text(_pf) != null) 'pfNumber': text(_pf),
        if (text(_esi) != null) 'esiNumber': text(_esi),
      },
      if (text(_natureOfContractor) != null) 'natureOfContractor': text(_natureOfContractor),
      if (!_isVisitor && _designationId != null) 'designationId': _designationId,
      // Staff have no vendor: they are employed by the company itself.
      if (!_isVisitor && !_isStaff && _vendorId != null) 'vendorId': _vendorId,
      // On edit, always send photoUrl: null clears a removed photo.
      if (_isEdit) 'photoUrl': _photoUrl else if (_photoUrl != null) 'photoUrl': _photoUrl,
      if (!_isVisitor && !_isStaff) ...{
        if (_aadhaarFrontPhotoId != null) 'aadhaarFrontPhotoId': _aadhaarFrontPhotoId,
        if (_aadhaarBackPhotoId != null) 'aadhaarBackPhotoId': _aadhaarBackPhotoId,
        if (text(_aadhaar) != null) ...{
          'govIdType': 'Aadhaar',
          'aadhaar': text(_aadhaar),
        },
        if (text(_pan) != null) 'pan': text(_pan)!.toUpperCase(),
      },
      if (_isVisitor) ...{
        'escortName': _escortName.text.trim(),
        if (text(_visitorCompany) != null) 'visitorCompany': text(_visitorCompany),
        if (_idProofPhotoId != null) 'idProofPhotoId': _idProofPhotoId,
      },
      if (_isEdit && _status != null) 'status': _status,
      if (!_isEdit && !_isStaff && _joinDate != null)
        'joinDate': _joinDate!.toIso8601String().substring(0, 10),
      // Guarded above, so this is always present on create — the API now
      // refuses a person with no site rather than quietly making an orphan.
      if (!_isEdit) 'siteId': _siteId,
      // No workerCode: IDs are always auto-generated server-side (W-/S-/V-####).
    };

    try {
      final Map<String, dynamic> saved;
      if (_isEdit) {
        final res = await dio.patch('/workers/${widget.workerId}', data: body);
        saved = res.data as Map<String, dynamic>;
        // The site lives on the assignment, not the worker row: a PATCH ignores
        // siteId, so moving someone needs its own call.
        if (_siteId != null && _siteId != _initialSiteId) {
          await dio.post('/workers/${widget.workerId}/assign-site', data: {
            'siteId': _siteId,
            if (!_isStaff && _vendorId != null) 'vendorId': _vendorId,
            'startDate': DateTime.now().toIso8601String().substring(0, 10),
          });
          _initialSiteId = _siteId;
        }
      } else {
        final res = await dio.post('/workers', data: body);
        saved = res.data as Map<String, dynamic>;
      }
      if (!mounted) return;
      final printNow = await showDialog<bool>(
        context: context,
        builder: (ctx) => AlertDialog(
          title: Text(_isEdit ? 'Saved' : 'Created — ID ${saved['workerCode']}'),
          content: const Text('Print the QR badge now?'),
          actions: [
            TextButton(onPressed: () => Navigator.pop(ctx, false), child: const Text('Later')),
            FilledButton(
              onPressed: () => Navigator.pop(ctx, true),
              child: const Text('Print badge'),
            ),
          ],
        ),
      );
      if (printNow == true && mounted) {
        await printWorkerCards(context, ref, [
          BadgeData(
            fullName: saved['fullName'] as String? ?? _name.text,
            workerCode: saved['workerCode'] as String? ?? '',
            designation: _designations
                .firstWhere((d) => d['id'] == _designationId, orElse: () => {})['name']
                as String?,
            vendor: _vendors.firstWhere((v) => v['id'] == _vendorId, orElse: () => {})['name']
                as String?,
            siteName: _siteName,
            gender: _gender,
            dateOfBirth: _dob?.toIso8601String().substring(0, 10),
            bloodGroup: _bloodGroup.text.trim().isEmpty ? null : _bloodGroup.text.trim(),
            emergencyName: _emergencyName.text.trim().isEmpty ? null : _emergencyName.text.trim(),
            emergencyNumber:
                _emergencyNumber.text.trim().isEmpty ? null : _emergencyNumber.text.trim(),
            screeningDoneOn: _screeningOn?.toIso8601String().substring(0, 10),
            screeningDoneBy: _screeningBy.text.trim().isEmpty ? null : _screeningBy.text.trim(),
            inductionDoneOn: _inductionOn?.toIso8601String().substring(0, 10),
            inductedBy: _inductedBy.text.trim().isEmpty ? null : _inductedBy.text.trim(),
            validityTill: _validityTill?.toIso8601String().substring(0, 10),
            photoUrl: _photoUrl,
            isVisitor: _isVisitor,
          ),
        ]);
      }
      if (mounted) Navigator.of(context).pop(true);
    } on DioException catch (e) {
      if (mounted) {
        setState(() {
          _saving = false;
          _error = _friendlyError(e, 'Save failed');
        });
      }
    }
  }

  Widget _text(TextEditingController c, String label,
      {TextInputType? keyboard, String? Function(String?)? validator}) {
    return Padding(
      padding: const EdgeInsets.only(bottom: 12),
      child: TextFormField(
        controller: c,
        keyboardType: keyboard,
        validator: validator,
        decoration: InputDecoration(labelText: label),
      ),
    );
  }

  Widget _section(String title, List<Widget> children, {bool initiallyExpanded = false}) {
    return Card(
      margin: const EdgeInsets.only(bottom: ClamsSpacing.md),
      child: ExpansionTile(
        title: SectionHeader(title),
        shape: const Border(),
        collapsedShape: const Border(),
        initiallyExpanded: initiallyExpanded,
        childrenPadding: const EdgeInsets.fromLTRB(
            ClamsSpacing.lg, ClamsSpacing.xs, ClamsSpacing.lg, ClamsSpacing.sm),
        children: children,
      ),
    );
  }

  Future<void> _pickDate({
    required DateTime? current,
    required DateTime first,
    required ValueChanged<DateTime> onPicked,
    DateTime? last,
  }) async {
    final picked = await showDatePicker(
      context: context,
      initialDate: current ?? DateTime.now(),
      firstDate: first,
      lastDate: last ?? DateTime.now(),
    );
    if (picked != null) onPicked(picked);
  }

  @override
  Widget build(BuildContext context) {
    return Scaffold(
      appBar: AppBar(
        title: Text(_isEdit
            ? 'Edit — ${_existing?['fullName'] ?? ''}'
            : 'New ${_category == 'WORKER' ? 'worker' : _category.toLowerCase()}'),
      ),
      body: _loading
          ? const Center(child: CircularProgressIndicator())
          : Form(
              key: _formKey,
              child: ListView(
                padding: const EdgeInsets.all(16),
                children: [
                  if (_error != null)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: Text(_error!,
                          style: const TextStyle(color: ClamsColors.error)),
                    ),
                  Row(
                    children: [
                      GestureDetector(
                        onTap: _uploadingPhoto ? null : _choosePhotoSource,
                        child: _uploadingPhoto
                            ? const CircleAvatar(radius: 36, child: CircularProgressIndicator())
                            : ApiCircleAvatar(photoUrl: _photoUrl, radius: 36),
                      ),
                      const SizedBox(width: 12),
                      Expanded(
                        child: OutlinedButton.icon(
                          onPressed: _uploadingPhoto ? null : _choosePhotoSource,
                          icon: const Icon(Icons.photo_camera),
                          label: Text(_photoUrl == null ? 'Add photo (optional)' : 'Change photo'),
                        ),
                      ),
                    ],
                  ),
                  const SizedBox(height: 12),
                  // Staff: no Gov ID at all — no Aadhaar images, no scan, no
                  // Aadhaar/PAN numbers.
                  if (!_isVisitor && !_isStaff)
                    Card(
                      margin: const EdgeInsets.only(bottom: 12),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                const Icon(Icons.badge_outlined, size: 18),
                                const SizedBox(width: 8),
                                const Expanded(
                                    child: SectionHeader('Aadhaar card images')),
                                if (_uploadingAadhaar)
                                  const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                _documentTile('Front *', 'AADHAAR_FRONT',
                                    _aadhaarFrontPhotoId, _uploadingAadhaar),
                                const SizedBox(width: 12),
                                _documentTile('Back', 'AADHAAR_BACK', _aadhaarBackPhotoId,
                                    _uploadingAadhaar),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(
                              'Encrypted & compressed at rest. Front required; back optional.',
                              style: Theme.of(context)
                                  .textTheme
                                  .bodySmall
                                  ?.copyWith(color: ClamsColors.textSecondary),
                            ),
                          ],
                        ),
                      ),
                    ),
                  if (_isEdit)
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: TextFormField(
                        enabled: false,
                        initialValue: _workerCode,
                        decoration:
                            const InputDecoration(labelText: 'ID (auto-generated)'),
                      ),
                    ),
                  if (!_isEdit && !_isVisitor && !_isStaff) ...[
                    OutlinedButton.icon(
                      onPressed: _scanAadhaar,
                      icon: const Icon(Icons.qr_code_scanner),
                      label: const Text('Scan Aadhaar QR to autofill'),
                    ),
                    const SizedBox(height: 12),
                  ],
                  DropdownButtonFormField<String>(
                    initialValue: _category,
                    decoration: const InputDecoration(labelText: 'Type'),
                    items: const [
                      DropdownMenuItem(value: 'WORKER', child: Text('Worker')),
                      DropdownMenuItem(value: 'STAFF', child: Text('Staff')),
                      DropdownMenuItem(value: 'VISITOR', child: Text('Visitor')),
                    ],
                    onChanged: _isEdit ? null : (v) => setState(() => _category = v ?? 'WORKER'),
                  ),
                  const SizedBox(height: 12),
                  _text(_name, 'Full name *',
                      validator: (v) =>
                          (v == null || v.trim().length < 2) ? 'Name is required' : null),
                  if (!_isVisitor) _text(_fatherName, "Father's name"),
                  Row(
                    children: [
                      Expanded(
                        child: DropdownButtonFormField<String>(
                          initialValue: _gender,
                          decoration: const InputDecoration(labelText: 'Gender'),
                          items: const [
                            DropdownMenuItem(value: 'M', child: Text('Male')),
                            DropdownMenuItem(value: 'F', child: Text('Female')),
                            DropdownMenuItem(value: 'OTHER', child: Text('Other')),
                          ],
                          onChanged: (v) => setState(() => _gender = v),
                        ),
                      ),
                      if (!_isVisitor) ...[
                        const SizedBox(width: 12),
                        Expanded(
                          child: OutlinedButton(
                            onPressed: () => _pickDate(
                              current: _dob,
                              first: DateTime(1940),
                              onPicked: (d) => setState(() => _dob = d),
                            ),
                            child: Text(
                              _dob == null
                                  ? 'Date of birth'
                                  : 'DOB: ${_dob!.day}/${_dob!.month}/${_dob!.year}',
                            ),
                          ),
                        ),
                      ],
                    ],
                  ),
                  const SizedBox(height: 12),
                  _text(_mobile, 'Mobile number', keyboard: TextInputType.phone),
                  Row(
                    children: [
                      if (!_isVisitor && !_isStaff) ...[
                        Expanded(
                            child:
                                _text(_pincode, 'Pincode', keyboard: TextInputType.number)),
                        const SizedBox(width: 12),
                      ],
                      Expanded(child: _text(_bloodGroup, 'Blood group')),
                    ],
                  ),
                  if (!_isVisitor) _text(_language, 'Language'),
                  if (_isEdit) ...[
                    DropdownButtonFormField<String>(
                      initialValue: _status,
                      decoration: const InputDecoration(labelText: 'Status'),
                      items: const [
                        DropdownMenuItem(value: 'ACTIVE', child: Text('Active')),
                        DropdownMenuItem(value: 'INACTIVE', child: Text('Inactive')),
                        DropdownMenuItem(value: 'SUSPENDED', child: Text('Suspended')),
                        DropdownMenuItem(value: 'EXITED', child: Text('Exited')),
                      ],
                      onChanged: (v) => setState(() => _status = v),
                    ),
                    const SizedBox(height: 12),
                  ],

                  if (_isVisitor) ...[
                    _text(_escortName, 'Escort name *',
                        validator: (v) => (v == null || v.trim().isEmpty)
                            ? 'Escort name is required for visitors'
                            : null),
                    _text(_visitorCompany, 'Visitor company'),
                    Card(
                      margin: const EdgeInsets.only(bottom: 12),
                      child: Padding(
                        padding: const EdgeInsets.all(12),
                        child: Column(
                          crossAxisAlignment: CrossAxisAlignment.start,
                          children: [
                            Row(
                              children: [
                                const Icon(Icons.badge_outlined, size: 18),
                                const SizedBox(width: 8),
                                const Expanded(
                                    child: SectionHeader('ID proof (optional)')),
                                if (_uploadingIdProof)
                                  const SizedBox(
                                    width: 16,
                                    height: 16,
                                    child: CircularProgressIndicator(strokeWidth: 2),
                                  ),
                              ],
                            ),
                            const SizedBox(height: 8),
                            Row(
                              children: [
                                _documentTile('ID proof', 'ID_PROOF', _idProofPhotoId,
                                    _uploadingIdProof),
                              ],
                            ),
                            const SizedBox(height: 6),
                            Text(
                              'Encrypted at rest.',
                              style: Theme.of(context).textTheme.bodySmall,
                            ),
                          ],
                        ),
                      ),
                    ),
                    if (!_isEdit)
                      Padding(
                        padding: const EdgeInsets.only(bottom: 12),
                        child: OutlinedButton(
                          onPressed: () => _pickDate(
                            current: _joinDate,
                            first: DateTime(2000),
                            onPicked: (d) => setState(() => _joinDate = d),
                          ),
                          child: Text(
                            _joinDate == null
                                ? 'Visit date (today)'
                                : 'Visit: ${_joinDate!.day}/${_joinDate!.month}/${_joinDate!.year}',
                          ),
                        ),
                      ),
                  ],

                  if (!_isVisitor)
                    _section('Designation & assignment', initiallyExpanded: true, [
                      DropdownButtonFormField<String>(
                        initialValue: _designationId,
                        decoration: const InputDecoration(labelText: 'Designation'),
                        items: [
                          const DropdownMenuItem(value: null, child: Text('—')),
                          for (final d in _designations)
                            DropdownMenuItem(
                                value: d['id'] as String, child: Text(d['name'] as String)),
                        ],
                        onChanged: (v) => setState(() => _designationId = v),
                      ),
                      const SizedBox(height: 12),
                      // Staff are employed by the company — no vendor to pick.
                      if (_isStaff)
                        TextFormField(
                          key: ValueKey(_companyName),
                          initialValue: _companyName ?? 'Loading…',
                          enabled: false,
                          decoration: const InputDecoration(
                            labelText: 'Company',
                            helperText: 'Staff are employed by the company',
                          ),
                        )
                      else
                        DropdownButtonFormField<String>(
                          initialValue: _vendorId,
                          decoration:
                              const InputDecoration(labelText: 'Contractor (vendor)'),
                          items: [
                            const DropdownMenuItem(value: null, child: Text('—')),
                            for (final v in _vendors)
                              DropdownMenuItem(
                                  value: v['id'] as String, child: Text(v['name'] as String)),
                          ],
                          onChanged: (v) => setState(() => _vendorId = v),
                        ),
                      const SizedBox(height: 12),
                      // Defaults to this device's active site, but a supervisor
                      // can enrol someone onto another site from here.
                      DropdownButtonFormField<String>(
                        initialValue:
                            _sites.any((s) => s['id'] == _siteId) ? _siteId : null,
                        decoration: const InputDecoration(labelText: 'Site'),
                        items: [
                          const DropdownMenuItem(value: null, child: Text('—')),
                          for (final s in _sites)
                            DropdownMenuItem(
                                value: s['id'] as String, child: Text(s['name'] as String)),
                        ],
                        onChanged: (v) => setState(() {
                          _siteId = v;
                          _siteName = _sites.firstWhere((s) => s['id'] == v,
                              orElse: () => {})['name'] as String?;
                        }),
                      ),
                      const SizedBox(height: 12),
                      if (_category == 'WORKER')
                        _text(_natureOfContractor, 'Nature of contractor'),
                      if (!_isEdit && !_isStaff)
                        Padding(
                          padding: const EdgeInsets.only(bottom: 12),
                          child: OutlinedButton(
                            onPressed: () => _pickDate(
                              current: _joinDate,
                              first: DateTime(2000),
                              onPicked: (d) => setState(() => _joinDate = d),
                            ),
                            child: Text(
                              _joinDate == null
                                  ? 'Joining date (today)'
                                  : 'Joining: ${_joinDate!.day}/${_joinDate!.month}/${_joinDate!.year}',
                            ),
                          ),
                        ),
                    ]),

                  if (!_isVisitor)
                    _section(_isStaff ? 'Emergency contact' : 'Emergency & nominee', [
                      _text(_emergencyName, 'Emergency contact name'),
                      _text(_emergencyNumber, 'Emergency contact number',
                          keyboard: TextInputType.phone),
                      if (!_isStaff) _text(_nomineeName, 'Nominee name'),
                      if (!_isStaff) _text(_nomineeRelation, 'Nominee relation (e.g. Wife)'),
                    ]),

                  // Screening and induction are the same step on site, so only
                  // induction is captured.
                  if (!_isVisitor)
                    _section('Induction & ID card', [
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: OutlinedButton(
                        onPressed: () => _pickDate(
                          current: _inductionOn,
                          first: DateTime(2000),
                          onPicked: (d) => setState(() => _inductionOn = d),
                        ),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            _inductionOn == null
                                ? 'Induction done on'
                                : 'Induction done on: ${_inductionOn!.day}/${_inductionOn!.month}/${_inductionOn!.year}',
                          ),
                        ),
                      ),
                    ),
                    _text(_inductedBy, 'Inducted by'),
                    Padding(
                      padding: const EdgeInsets.only(bottom: 12),
                      child: OutlinedButton(
                        onPressed: () => _pickDate(
                          current: _validityTill,
                          first: DateTime(2000),
                          last: DateTime(2100),
                          onPicked: (d) => setState(() => _validityTill = d),
                        ),
                        child: Align(
                          alignment: Alignment.centerLeft,
                          child: Text(
                            _validityTill == null
                                ? 'Validity till'
                                : 'Validity till: ${_validityTill!.day}/${_validityTill!.month}/${_validityTill!.year}',
                          ),
                        ),
                      ),
                    ),
                  ]),

                  if (!_isVisitor && !_isStaff)
                    _section('Bank & statutory', [
                      _text(_bankName, 'Bank name'),
                      _text(_bankAccount, 'Account number', keyboard: TextInputType.number),
                      _text(_ifsc, 'IFSC code'),
                      _text(_pf, 'PF number'),
                      _text(_esi, 'ESI number'),
                    ]),

                  if (!_isVisitor && !_isStaff)
                    _section('Gov ID (Aadhaar / PAN)', [
                    _text(
                      _aadhaar,
                      _isEdit
                          ? 'Aadhaar number (blank = keep existing)'
                          : 'Aadhaar number (optional, encrypted)',
                      keyboard: TextInputType.number,
                    ),
                    _text(
                      _pan,
                      _isEdit
                          ? 'PAN number (blank = keep existing)'
                          : 'PAN number (optional, encrypted)',
                    ),
                  ]),

                  const SizedBox(height: 8),
                  FilledButton(
                    onPressed: _saving ? null : _save,
                    child: Text(_saving
                        ? 'Saving…'
                        : _isEdit
                            ? 'Save changes'
                            : 'Create & generate QR'),
                  ),
                  const SizedBox(height: 24),
                ],
              ),
            ),
    );
  }
}
